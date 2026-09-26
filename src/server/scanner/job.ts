import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { AppError, toAppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { AUDIT_ACTIONS, recordAudit } from '@/server/audit/log';
import { recordActivity } from '@/server/activity/feed';
import { isPaused } from '@/server/business/pause';
import { registerJobHandler } from '@/server/jobs/worker';
import { JOB_TYPES, websiteScanPayload } from '@/server/jobs/types';
import { loadEnabledPaidProviders, runProvider } from '@/server/providers';
import type { WebFetchProvider } from '@/server/providers/types';
import { requireBusinessContext, type BusinessContext } from '@/server/tenancy/context';
import { crawlWebsite, type CrawlResult } from './crawler';
import { persistScan, type ChangeSummary } from './persist';

/**
 * The website scan job.
 *
 * This is the first production code path that goes through `runProvider`, so
 * it is also the first place the cost machinery does real work: every page
 * fetched writes a cost row, which in zero-cost mode reads "N operations,
 * $0.00" on the Costs page.
 *
 * The fetcher is wrapped once per scan rather than per page. Wrapping each
 * page would write one cost row per fetch — accurate, but it would bury the
 * cost table under hundreds of rows for a single user action. One row per
 * scan, carrying the total bytes, is the useful granularity.
 */

/**
 * Whether a pause arrived after a crawl began, and so should stop it.
 *
 * Exported because it is the whole rule, and it cannot be reached through the
 * job in a test: `crawlWebsite` validates its start URL against the strict URL
 * policy, which by design has no configuration path and no test escape hatch,
 * so the job can only be run in tests against hosts that never resolve.
 *
 * The distinction it draws is the one that matters. "Is the business paused?"
 * looks equivalent and silently broke reading a site while advertising was
 * already off: the crawl started, asked, and stopped before its first page,
 * recording CANCELLED with nothing in it. Pressing pause *during* a crawl
 * still stops it within a page, which is what the check is for.
 */
export function pausedSince(pausedAt: Date | null, startedAtMs: number): boolean {
  return pausedAt !== null && pausedAt.getTime() > startedAtMs;
}

export async function runWebsiteScanJob(rawPayload: unknown): Promise<Prisma.InputJsonValue> {
  const payload = websiteScanPayload.parse(rawPayload);
  const log = logger().child({ scanRunId: payload.scanRunId, businessId: payload.businessId });

  const scanRun = await prisma.scanRun.findUnique({ where: { id: payload.scanRunId } });
  if (!scanRun) {
    throw new AppError('NOT_FOUND', `ScanRun ${payload.scanRunId} no longer exists`, {
      retryable: false,
    });
  }

  const business = await prisma.business.findUnique({ where: { id: payload.businessId } });
  if (!business) {
    throw new AppError('NOT_FOUND', `Business ${payload.businessId} no longer exists`, {
      retryable: false,
    });
  }

  /*
   * A pause that landed after the job was queued must still stop it — but only
   * for a scan the system decided to run. A scan the owner asked for is left
   * to finish: it spends nothing and advertises nothing, and cancelling it
   * here would mean the button appeared to work and then quietly did nothing,
   * minutes later, with the owner long gone.
   */
  if (isPaused(business) && !payload.ownerRequested) {
    await prisma.scanRun.update({
      where: { id: scanRun.id },
      data: { status: 'CANCELLED', finishedAt: new Date(), stopReason: 'business-paused' },
    });
    log.info('Scan cancelled: business is paused');
    return { cancelled: true, reason: 'business-paused' };
  }

  // The job runs outside any request, so the tenant context is rebuilt from
  // the owning membership rather than a session. Data access stays scoped.
  const context = await buildSystemContext(payload.businessId);

  await prisma.scanRun.update({
    where: { id: scanRun.id },
    data: { status: 'RUNNING', startedAt: new Date() },
  });

  try {
    const enabledPaid = await loadEnabledPaidProviders(context.workspace.id);

    // Captured before the first fetch, so "paused since this scan started" is
    // a question with an answer.
    const crawlStartedAt = Date.now();

    const outcome = await runProvider<WebFetchProvider, CrawlResult>({
      capability: 'WEB_FETCH',
      kind: 'WEB_FETCH',
      workspaceId: context.workspace.id,
      businessId: context.businessId,
      enabledPaid,
      subjectType: 'ScanRun',
      subjectId: scanRun.id,
      execute: async (fetcher) => {
        const crawl = await crawlWebsite({
          startUrl: payload.requestedUrl,
          fetcher,
          log,
          /*
           * Never plan to run longer than the invocation is allowed to live.
           * On a host that kills functions at a fixed timeout, a crawl that
           * overruns is killed mid-page and the whole attempt is repeated;
           * stopping ourselves first means the scan reports PARTIAL with the
           * pages it did read, which is accurate and useful, and a rescan
           * continues from a warm content-hash cache.
           */
          limits: { maxDurationMs: crawlBudgetMs() },
          /*
           * Re-read on every page so pressing "Pause everything" mid-crawl
           * stops it within one page rather than at the end.
           *
           * What counts is a pause that began *after* this scan did. Stopping
           * on any pause at all looks equivalent and is not: an owner who
           * asked to read their site while advertising was already paused got
           * a scan that started, checked, and cancelled itself before reading
           * a single page — reported as CANCELLED with nothing in it, which
           * reads as the button not working. Pressing pause during the crawl
           * still stops it, which is the case this check exists for.
           */
          shouldStop: async () => {
            const current = await prisma.business.findUnique({
              where: { id: payload.businessId },
              select: { pausedAt: true },
            });
            return pausedSince(current?.pausedAt ?? null, crawlStartedAt);
          },
        });

        return {
          value: crawl,
          usage: {
            units: crawl.bytesFetched,
            unitLabel: 'bytes',
            estimatedCostCents: 0,
            actualCostCents: 0,
          },
        };
      },
    });

    const crawl = outcome.value;

    // A crawl that read nothing is a failed scan, not an empty website. It is
    // raised here rather than persisted so the owner is told why, and so the
    // Website page shows the reason instead of a blank "no products found".
    if (crawl.stopReason === 'unreachable') {
      const reason = describeUnreachable(crawl);

      // The `catch` below writes FAILED and the owner-facing message; the
      // per-URL warnings are recorded here so a support question about "why
      // couldn't it read my site" can be answered from the row itself.
      await prisma.scanRun.update({
        where: { id: scanRun.id },
        data: {
          stopReason: crawl.stopReason,
          pagesSkipped: crawl.pagesSkipped,
          warnings: crawl.warnings as unknown as Prisma.InputJsonValue,
        },
      });

      throw new AppError('CRAWL_ERROR', `Crawl read no pages: ${reason}`, {
        // Retrying will not help: the address was refused, the host does not
        // resolve, or robots.txt forbids us. The owner can rescan once they
        // have changed something.
        retryable: false,
        publicMessage: reason,
        details: { warnings: crawl.warnings.slice(0, 5) },
      });
    }

    const persisted = await persistScan(context, scanRun.id, crawl, prisma);

    const status =
      crawl.stopReason === 'completed'
        ? 'COMPLETED'
        : crawl.stopReason === 'cancelled'
          ? 'CANCELLED'
          : 'PARTIAL';

    await prisma.scanRun.update({
      where: { id: scanRun.id },
      data: {
        status,
        finishedAt: new Date(),
        pagesFetched: crawl.pagesFetched,
        pagesSkipped: crawl.pagesSkipped,
        bytesFetched: crawl.bytesFetched,
        productsFound: persisted.productsFound,
        factsExtracted: persisted.factsExtracted,
        stopReason: crawl.stopReason,
        warnings: crawl.warnings as unknown as Prisma.InputJsonValue,
        changeSummary: persisted.changeSummary as unknown as Prisma.InputJsonValue,
        websiteId: persisted.websiteId,
      },
    });

    await recordAudit({
      workspaceId: context.workspace.id,
      businessId: context.businessId,
      actorType: 'SYSTEM',
      action: AUDIT_ACTIONS.websiteScanCompleted,
      objectType: 'ScanRun',
      objectId: scanRun.id,
      newValue: {
        status,
        pagesFetched: crawl.pagesFetched,
        productsFound: persisted.productsFound,
        stopReason: crawl.stopReason,
      },
    });

    await writeActivity(context, crawl, persisted.changeSummary, persisted.productsFound);

    log.info('Scan finished', {
      status,
      pages: crawl.pagesFetched,
      products: persisted.productsFound,
      facts: persisted.factsExtracted,
    });

    return {
      status,
      pagesFetched: crawl.pagesFetched,
      productsFound: persisted.productsFound,
      factsExtracted: persisted.factsExtracted,
      stopReason: crawl.stopReason,
    };
  } catch (thrown) {
    const error = toAppError(thrown);

    await prisma.scanRun.update({
      where: { id: scanRun.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: { code: error.code, message: error.publicMessage },
      },
    });

    await recordActivity(context, {
      kind: 'needsYourInput',
      message: `Could not read ${hostOf(payload.requestedUrl)}. ${error.publicMessage}`,
      needsAttention: true,
      detail: { scanRunId: scanRun.id, code: error.code },
    });

    throw error;
  }
}

/**
 * How long a single crawl may run.
 *
 * Derived from the worker's own budget rather than configured separately, so
 * there is one number to set per host and no way for the two to disagree. The
 * margin leaves room for persisting what was found: being killed after the
 * crawl but before the write would lose the whole scan.
 */
function crawlBudgetMs(): number {
  const budget = getEnv().WORKER_MAX_RUN_MS;
  return Math.max(10_000, Math.floor(budget * 0.8));
}

/**
 * Explains, in the owner's words, why a crawl read nothing.
 *
 * The warning for the page they actually asked for is the one that matters —
 * a later failure on a sitemap entry says nothing about why their homepage
 * could not be read. Each reason maps to a sentence a shop owner can act on;
 * anything unrecognised falls back to the fetch layer's own public message
 * rather than a code, and to a plain sentence if there is none.
 */
function describeUnreachable(crawl: CrawlResult): string {
  const root = crawl.warnings.find(
    (warning) => warning.url === crawl.rootUrl || warning.url === `${crawl.rootUrl}/`,
  );
  const warning = root ?? crawl.warnings.find((w) => w.reason !== 'robots-not-plain-text');

  if (!warning) {
    return 'Nothing could be read from that address. Check that the website is online.';
  }

  switch (warning.reason) {
    case 'unsafe-url':
      return 'That address is not one we can scan. It must be a public http:// or https:// website.';
    case 'robots-disallowed':
      return 'The website’s robots.txt asks crawlers not to read it, so we stopped.';
    case 'not-html':
      return 'That address is not a web page, so there was nothing to read.';
    case 'PROVIDER_TIMEOUT':
      return 'The website took too long to respond. It may be slow or temporarily down.';
    default:
      break;
  }

  if (warning.reason.startsWith('http-')) {
    return describeHttpStatus(warning.reason.slice(5));
  }

  return warning.detail ?? 'The website could not be read.';
}

/**
 * An HTTP status, in terms of what the owner can do about it.
 *
 * `The website answered with an error (403)` was accurate and worthless: it
 * described the symptom to somebody who cannot read an HTTP status code, and
 * left them with nowhere to go. A 403 on a site the owner controls almost
 * always means a firewall or bot protection in front of it refused us — which
 * is a setting they can change, once they know that is what it is.
 *
 * The user agent is named because that is the string they need to allow, and
 * guessing it is not something an owner should have to do.
 */
export function describeHttpStatus(code: string): string {
  const agent = getEnv().CRAWLER_USER_AGENT;

  switch (code) {
    case '401':
    case '403':
      return (
        'The website refused us (' +
        code +
        '). This is almost always a firewall or bot protection in front of the ' +
        'site rather than a problem with the site itself — Cloudflare’s bot ' +
        'protection does it by default. Allow the visitor named “' +
        agent +
        '” in that service’s settings, then read the site again.'
      );
    case '404':
      return 'That page was not found on the website (404). Check the address.';
    case '429':
      return (
        'The website asked us to slow down (429). We already wait between ' +
        'pages, so this usually means rate limiting in front of the site. ' +
        'Allowing “' +
        agent +
        '” there, or trying again later, should fix it.'
      );
    case '500':
    case '502':
    case '503':
    case '504':
      return `The website itself returned an error (${code}). That is a problem at the site's end, not ours — try again once it is back.`;
    default:
      return `The website answered with an error (${code}), so there was nothing to read.`;
  }
}

/**
 * Writes the owner-facing summary of what the scan found.
 *
 * Composed here from verified counts — never from page text, which is
 * untrusted, and never from a model, which does not run in this phase.
 */
async function writeActivity(
  context: BusinessContext,
  crawl: CrawlResult,
  changes: ChangeSummary,
  productsFound: number,
): Promise<void> {
  const host = hostOf(crawl.resolvedRootUrl);

  if (changes.isFirstScan) {
    const productPart =
      productsFound === 0
        ? 'No products were found on it.'
        : `Found ${productsFound} ${productsFound === 1 ? 'product' : 'products'}.`;
    await recordActivity(context, {
      kind: 'productsFound',
      message: `Read ${crawl.pagesFetched} ${crawl.pagesFetched === 1 ? 'page' : 'pages'} of ${host}. ${productPart}`,
      detail: { pagesFetched: crawl.pagesFetched, productsFound },
      ...(productsFound === 0 ? { needsAttention: true } : {}),
    });
    return;
  }

  if (changes.newProducts.length > 0) {
    await recordActivity(context, {
      kind: 'productsFound',
      message: `${changes.newProducts.length} new ${changes.newProducts.length === 1 ? 'product' : 'products'} appeared on ${host}.`,
      detail: { products: changes.newProducts.slice(0, 10) },
    });
  }

  for (const change of changes.priceChanges.slice(0, 5)) {
    await recordActivity(context, {
      kind: 'priceChanged',
      message: `Price changed for ${change.name}. Advertising materials will be updated.`,
      detail: change as unknown as Prisma.InputJsonValue,
    });
  }

  for (const change of changes.availabilityChanges.slice(0, 5)) {
    if (change.to !== 'OUT_OF_STOCK') continue;
    // Out of stock is an attention item: continuing to advertise it would
    // break the "never advertise an unavailable product" rule.
    await recordActivity(context, {
      kind: 'productUnavailable',
      message: `${change.name} is out of stock. It will not be advertised until it is back.`,
      needsAttention: true,
      detail: change as unknown as Prisma.InputJsonValue,
    });
  }

  for (const removed of changes.removedProducts.slice(0, 5)) {
    await recordActivity(context, {
      kind: 'productUnavailable',
      message: `${removed.name} is no longer on the website.`,
      needsAttention: true,
      detail: removed as unknown as Prisma.InputJsonValue,
    });
  }

  if (
    changes.newProducts.length === 0 &&
    changes.priceChanges.length === 0 &&
    changes.availabilityChanges.length === 0 &&
    changes.removedProducts.length === 0
  ) {
    await recordActivity(context, {
      kind: 'websiteScanned',
      message: `Checked ${host}. Nothing has changed.`,
      detail: { pagesFetched: crawl.pagesFetched },
    });
  }
}

/**
 * Builds a tenant context for work with no signed-in user.
 *
 * Attributed to the workspace's owner so audit rows name a real principal, and
 * routed through `requireBusinessContext` so the capability object is produced
 * by the same membership check every other caller passes — a background job
 * gets no shortcut around tenancy.
 */
async function buildSystemContext(businessId: string): Promise<BusinessContext> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { workspaceId: true },
  });
  if (!business) {
    throw new AppError('NOT_FOUND', `Business ${businessId} no longer exists`, {
      retryable: false,
    });
  }

  const membership = await prisma.workspaceMembership.findFirst({
    where: { workspaceId: business.workspaceId, role: 'OWNER' },
    include: { user: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!membership) {
    throw new AppError('CONFIGURATION_ERROR', `Workspace has no owner`, { retryable: false });
  }

  return requireBusinessContext(membership.user, businessId);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** Registers the handler. Imported for its side effect by the worker entry point. */
export function registerScannerJobs(): void {
  registerJobHandler(JOB_TYPES.websiteScan, (payload) => runWebsiteScanJob(payload));
}

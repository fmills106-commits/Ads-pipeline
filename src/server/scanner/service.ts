import type { ScanRun } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { conflict, toAppError, validationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { assertSafePublicUrl, normaliseUrl } from '@/lib/net-safety';
import { AUDIT_ACTIONS, recordAudit } from '@/server/audit/log';
import { recordActivity } from '@/server/activity/feed';
import { isPaused } from '@/server/business/pause';
import { enqueue } from '@/server/jobs/queue';
import { JOB_TYPES } from '@/server/jobs/types';
import type { BusinessContext } from '@/server/tenancy/context';
import type { ChangeSummary } from './persist';

/**
 * Starting and reporting on scans.
 *
 * The scan itself runs in a background job (see `job.ts`) because crawling a
 * site takes minutes, not the milliseconds a web request should. This module
 * is the part that runs inside a request: validate, create the ScanRun row,
 * enqueue, and return something the UI can poll.
 */

export interface StartScanInput {
  /** Defaults to the business's configured website. */
  url?: string;
}

export interface StartScanResult {
  scanRun: ScanRun;
  jobId: string;
  /** False when an identical scan was already queued or running. */
  created: boolean;
}

/**
 * Queues a scan.
 *
 * Refuses when the business is paused: a paused business does no work at all,
 * and that gate lives here rather than in the UI so a background trigger
 * cannot bypass it.
 */
export async function startScan(
  context: BusinessContext,
  input: StartScanInput = {},
  db: Db = prisma,
): Promise<StartScanResult> {
  if (isPaused(context.business)) {
    throw conflict('Business is paused', {
      publicMessage: 'Advertising is paused for this business. Resume it to scan the website.',
    });
  }

  const raw = input.url ?? context.business.websiteUrl;
  if (!raw) {
    throw validationError('No website URL configured for this business', {
      publicMessage: 'Add your website address first, then we can read it.',
    });
  }

  // Validated here as well as in the fetcher: failing at the point the user
  // pressed the button gives a far better message than failing in a worker.
  const url = assertSafePublicUrl(raw);
  const requestedUrl = normaliseUrl(url);

  // An in-flight scan for the same business is reused rather than duplicated.
  const existing = await db.scanRun.findFirst({
    where: { businessId: context.businessId, status: { in: ['QUEUED', 'RUNNING'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) {
    return {
      scanRun: existing,
      jobId: existing.jobId ?? '',
      created: false,
    };
  }

  const scanRun = await db.scanRun.create({
    data: { businessId: context.businessId, requestedUrl, status: 'QUEUED' },
  });

  const { job } = await enqueue(
    {
      type: JOB_TYPES.websiteScan,
      workspaceId: context.workspace.id,
      businessId: context.businessId,
      payload: {
        scanRunId: scanRun.id,
        businessId: context.businessId,
        requestedUrl,
        isRescan: false,
      },
      // One scan per business per run; the ScanRun id keeps it unique.
      idempotencyKey: `website.scan:${scanRun.id}`,
    },
    db,
  );

  await db.scanRun.update({ where: { id: scanRun.id }, data: { jobId: job.id } });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: context.businessId,
      actorType: 'USER',
      actorId: context.user.id,
      action: AUDIT_ACTIONS.websiteScanStarted,
      objectType: 'ScanRun',
      objectId: scanRun.id,
      newValue: { requestedUrl },
    },
    db,
  );

  await recordActivity(
    context,
    {
      kind: 'websiteScanned',
      message: `Started reading ${hostOf(requestedUrl)}.`,
      detail: { scanRunId: scanRun.id },
    },
    db,
  );

  logger().info('Scan queued', {
    businessId: context.businessId,
    scanRunId: scanRun.id,
    jobId: job.id,
  });

  return { scanRun: { ...scanRun, jobId: job.id }, jobId: job.id, created: true };
}

export interface ScanStatus {
  scanRun: ScanRun | null;
  /** Coarse progress for the UI: a crawl cannot know its own total up front. */
  phase: 'idle' | 'queued' | 'crawling' | 'done' | 'failed';
  pagesFetched: number;
  productsFound: number;
  factsExtracted: number;
  changeSummary: ChangeSummary | null;
  warnings: Array<{ url: string; reason: string; detail?: string }>;
}

export async function getScanStatus(
  context: BusinessContext,
  db: Db = prisma,
): Promise<ScanStatus> {
  const scanRun = await db.scanRun.findFirst({
    where: { businessId: context.businessId },
    orderBy: { createdAt: 'desc' },
  });

  if (!scanRun) {
    return {
      scanRun: null,
      phase: 'idle',
      pagesFetched: 0,
      productsFound: 0,
      factsExtracted: 0,
      changeSummary: null,
      warnings: [],
    };
  }

  const phase: ScanStatus['phase'] =
    scanRun.status === 'QUEUED'
      ? 'queued'
      : scanRun.status === 'RUNNING'
        ? 'crawling'
        : scanRun.status === 'FAILED' || scanRun.status === 'CANCELLED'
          ? 'failed'
          : 'done';

  return {
    scanRun,
    phase,
    pagesFetched: scanRun.pagesFetched,
    productsFound: scanRun.productsFound,
    factsExtracted: scanRun.factsExtracted,
    changeSummary: (scanRun.changeSummary as ChangeSummary | null) ?? null,
    warnings: Array.isArray(scanRun.warnings)
      ? (scanRun.warnings as Array<{ url: string; reason: string; detail?: string }>)
      : [],
  };
}

/** Everything the Website screen renders, in one round trip. */
export async function getWebsiteKnowledge(context: BusinessContext, db: Db = prisma) {
  const website = await db.website.findFirst({
    where: { businessId: context.businessId },
    orderBy: { createdAt: 'desc' },
  });

  if (!website) {
    return {
      website: null,
      pages: [],
      products: [],
      facts: [],
      factCount: 0,
      pageTypeCounts: {} as Record<string, number>,
    };
  }

  const [pages, products, facts, grouped, businessFactCount, productFactCount] = await Promise.all([
    db.websitePage.findMany({
      where: { websiteId: website.id },
      orderBy: [{ pageType: 'asc' }, { fetchedAt: 'desc' }],
      take: 200,
      select: {
        id: true,
        url: true,
        pageType: true,
        title: true,
        httpStatus: true,
        fetchedAt: true,
      },
    }),
    db.product.findMany({
      where: { websiteId: website.id, removedAt: null },
      orderBy: { lastSeenAt: 'desc' },
      take: 100,
      include: {
        images: { orderBy: { position: 'asc' }, take: 1 },
        _count: { select: { versions: true } },
      },
    }),
    // `facts` is the business-level list the page renders, so it is capped.
    // The headline count below is counted, not measured from this array —
    // showing `facts.length` would silently stop at the cap and would leave
    // out product facts entirely.
    db.businessFact.findMany({
      where: { businessId: context.businessId },
      orderBy: [{ confidence: 'desc' }, { key: 'asc' }],
      take: 100,
    }),
    db.websitePage.groupBy({
      by: ['pageType'],
      where: { websiteId: website.id },
      _count: { _all: true },
    }),
    db.businessFact.count({ where: { businessId: context.businessId } }),
    db.productFact.count({ where: { product: { businessId: context.businessId } } }),
  ]);

  const pageTypeCounts: Record<string, number> = {};
  for (const row of grouped) pageTypeCounts[row.pageType] = row._count._all;

  return {
    website,
    pages,
    products,
    facts,
    /** Every verified fact held for this business, business-level and per-product. */
    factCount: businessFactCount + productFactCount,
    pageTypeCounts,
  };
}

/** Marks a scan failed, for the job handler's error path. */
export async function markScanFailed(
  scanRunId: string,
  error: unknown,
  db: Db = prisma,
): Promise<void> {
  const appError = toAppError(error);
  await db.scanRun
    .update({
      where: { id: scanRunId },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: { code: appError.code, message: appError.publicMessage },
      },
    })
    .catch(() => undefined);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

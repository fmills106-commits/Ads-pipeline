import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User, Workspace } from '@prisma/client';
import { prisma } from '@/lib/db';
import { crawlWebsite, type CrawlResult } from '@/server/scanner/crawler';
import { persistScan } from '@/server/scanner/persist';
import { getScanStatus, getWebsiteKnowledge, startScan } from '@/server/scanner/service';
import { runWebsiteScanJob } from '@/server/scanner/job';
import { createLocalWebFetchProvider } from '@/server/providers/local/web-fetch';
import { pauseEverything } from '@/server/business/pause';
import { createBusiness } from '@/server/business/service';
import { requireBusinessContext, requireWorkspaceContext } from '@/server/tenancy/context';
import { recentActivity } from '@/server/activity/feed';
import type { UrlPolicy } from '@/lib/net-safety';
import { FIXTURE_PRODUCT_COUNT, startFixtureSite, type FixtureSite } from '../helpers/fixture-site';
import { createTestUser, createTestWorkspace, resetDatabase } from '../helpers/db';

let site: FixtureSite;
let policy: UrlPolicy;
let user: User;
let workspace: Workspace;

beforeAll(async () => {
  site = await startFixtureSite();
  policy = { allowedPrivateHosts: ['127.0.0.1'] };
}, 60_000);

afterAll(async () => {
  await site.close();
});

beforeEach(async () => {
  await resetDatabase();
  user = await createTestUser();
  workspace = await createTestWorkspace(user);
});

async function newBusiness(name = 'Alpine Bakery') {
  const workspaceContext = await requireWorkspaceContext(user, workspace.id);
  const business = await createBusiness(workspaceContext, { name });
  return requireBusinessContext(user, business.id);
}

/** Runs a real crawl of the fixture site. */
async function crawl(startUrl = site.origin): Promise<CrawlResult> {
  return crawlWebsite({
    startUrl,
    fetcher: createLocalWebFetchProvider(policy),
    urlPolicy: policy,
    sleep: async () => undefined,
    limits: { minDelayMs: 0, maxPages: 50 },
  });
}

describe('persisting a scan', () => {
  it('stores pages, products and facts under the right business', async () => {
    const context = await newBusiness();
    const scanRun = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });

    const result = await persistScan(context, scanRun.id, await crawl());

    expect(result.pagesStored).toBeGreaterThan(3);
    expect(result.productsFound).toBe(FIXTURE_PRODUCT_COUNT);
    expect(result.factsExtracted).toBeGreaterThan(0);

    const products = await prisma.product.findMany({ where: { businessId: context.businessId } });
    expect(products.every((product) => product.businessId === context.businessId)).toBe(true);
  });

  it('records every fact with a source URL, method and confidence', async () => {
    // A fact with no provenance is not a fact — that is the whole contract.
    const context = await newBusiness();
    const scanRun = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    await persistScan(context, scanRun.id, await crawl());

    const facts = await prisma.businessFact.findMany({ where: { businessId: context.businessId } });
    expect(facts.length).toBeGreaterThan(0);

    for (const fact of facts) {
      expect(fact.sourceUrl, fact.key).toMatch(/^https?:\/\//);
      expect(fact.confidence).toBeGreaterThan(0);
      expect(fact.confidence).toBeLessThanOrEqual(1);
      expect(fact.method).toBeTruthy();
    }
  });

  it('prefers structured data over guesswork when both are present', async () => {
    const context = await newBusiness();
    const scanRun = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    await persistScan(context, scanRun.id, await crawl());

    const email = await prisma.businessFact.findFirst({
      where: { businessId: context.businessId, key: 'contact.email' },
    });
    expect(email?.value).toBe('hello@alpinebakery.example');
    expect(email?.method).toBe('JSON_LD');
  });

  it('creates a first version for every new product', async () => {
    const context = await newBusiness();
    const scanRun = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    const result = await persistScan(context, scanRun.id, await crawl());

    expect(result.changeSummary.isFirstScan).toBe(true);
    expect(result.productsNew).toBe(FIXTURE_PRODUCT_COUNT);

    const versions = await prisma.productVersion.findMany();
    expect(versions).toHaveLength(FIXTURE_PRODUCT_COUNT);
    expect(versions.every((version) => version.versionNumber === 1)).toBe(true);
  });

  it('stores product images with their source URLs', async () => {
    const context = await newBusiness();
    const scanRun = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    await persistScan(context, scanRun.id, await crawl());

    const images = await prisma.productImage.findMany();
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((image) => image.sourceUrl.startsWith('http'))).toBe(true);
  });
});

describe('rescanning and change detection', () => {
  it('does not duplicate anything on an unchanged rescan', async () => {
    const context = await newBusiness();

    const first = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    await persistScan(context, first.id, await crawl());

    const second = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    const result = await persistScan(context, second.id, await crawl());

    expect(result.productsNew).toBe(0);
    expect(result.productsChanged).toBe(0);
    expect(await prisma.product.count()).toBe(FIXTURE_PRODUCT_COUNT);
    // Still one version each: nothing changed, so nothing was versioned.
    expect(await prisma.productVersion.count()).toBe(FIXTURE_PRODUCT_COUNT);
  });

  it('versions a price change instead of overwriting it', async () => {
    const context = await newBusiness();

    const first = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    await persistScan(context, first.id, await crawl());

    // Simulate the merchant raising a price between scans.
    const crawled = await crawl();
    for (const page of crawled.pages) {
      for (const product of page.extraction.products) {
        if (product.name?.value === 'Sourdough Starter' && product.priceCents) {
          product.priceCents.value = 2499;
        }
      }
    }

    const second = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    const result = await persistScan(context, second.id, crawled);

    expect(result.productsChanged).toBe(1);
    expect(result.changeSummary.priceChanges).toHaveLength(1);
    expect(result.changeSummary.priceChanges[0]).toMatchObject({
      fromCents: 1999,
      toCents: 2499,
    });

    // The old price is still readable in version 1.
    const product = await prisma.product.findFirstOrThrow({
      where: { name: 'Sourdough Starter' },
      include: { versions: { orderBy: { versionNumber: 'asc' } } },
    });
    expect(product.priceCents).toBe(2499);
    expect(product.versions).toHaveLength(2);
    expect((product.versions[0]!.snapshot as { priceCents: number }).priceCents).toBe(1999);
    expect(product.versions[1]!.changedFields).toContain('priceCents');
  });

  it('marks a product removed rather than deleting it', async () => {
    const context = await newBusiness();

    const first = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    await persistScan(context, first.id, await crawl());

    // A rescan that no longer finds one of the products.
    const crawled = await crawl();
    crawled.pages = crawled.pages.filter(
      (page) => page.extraction.products[0]?.name?.value !== 'Banneton Proofing Basket',
    );

    const second = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    const result = await persistScan(context, second.id, crawled);

    expect(result.productsRemoved).toBe(1);
    // Still present in the database: campaigns may reference it.
    const removed = await prisma.product.findFirstOrThrow({
      where: { name: 'Banneton Proofing Basket' },
    });
    expect(removed.removedAt).toBeInstanceOf(Date);
  });

  it('does not conclude a product was removed from an incomplete crawl', async () => {
    // A crawl that hit its page limit has simply not looked everywhere yet.
    const context = await newBusiness();

    const first = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    await persistScan(context, first.id, await crawl());

    const partial = await crawl();
    partial.pages = [];
    partial.stopReason = 'page-limit';

    const second = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    const result = await persistScan(context, second.id, partial);

    expect(result.productsRemoved).toBe(0);
    expect(await prisma.product.count({ where: { removedAt: null } })).toBe(FIXTURE_PRODUCT_COUNT);
  });
});

describe('tenant isolation', () => {
  it('keeps two businesses’ scan results completely separate', async () => {
    const a = await newBusiness('Business A');
    const b = await newBusiness('Business B');

    for (const context of [a, b]) {
      const scanRun = await prisma.scanRun.create({
        data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
      });
      await persistScan(context, scanRun.id, await crawl());
    }

    const knowledgeA = await getWebsiteKnowledge(a);
    const knowledgeB = await getWebsiteKnowledge(b);

    expect(knowledgeA.products).toHaveLength(FIXTURE_PRODUCT_COUNT);
    expect(knowledgeB.products).toHaveLength(FIXTURE_PRODUCT_COUNT);
    // Same site, same data, but stored under separate businesses.
    expect(knowledgeA.website?.id).not.toBe(knowledgeB.website?.id);
    expect(knowledgeA.products.every((p) => p.businessId === a.businessId)).toBe(true);
    expect(knowledgeB.products.every((p) => p.businessId === b.businessId)).toBe(true);
  });

  it('does not let another tenant read a business’s scan', async () => {
    const a = await newBusiness('Business A');

    const otherUser = await createTestUser();
    const otherWorkspace = await createTestWorkspace(otherUser);
    const otherContext = await requireWorkspaceContext(otherUser, otherWorkspace.id);
    const otherBusiness = await createBusiness(otherContext, { name: 'Outsider' });

    const scanRun = await prisma.scanRun.create({
      data: { businessId: a.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });
    await persistScan(a, scanRun.id, await crawl());

    // The outsider's own view shows nothing.
    const outsider = await requireBusinessContext(otherUser, otherBusiness.id);
    expect((await getWebsiteKnowledge(outsider)).products).toHaveLength(0);
    expect((await getScanStatus(outsider)).scanRun).toBeNull();

    // And they cannot reach the other business at all.
    await expect(requireBusinessContext(otherUser, a.businessId)).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    });
  });
});

describe('starting a scan', () => {
  it('creates a scan run and a job', async () => {
    const workspaceContext = await requireWorkspaceContext(user, workspace.id);
    const business = await createBusiness(workspaceContext, {
      name: 'Queued Co',
      websiteUrl: 'https://example.com',
    });
    const context = await requireBusinessContext(user, business.id);

    const result = await startScan(context);

    expect(result.created).toBe(true);
    expect(result.scanRun.status).toBe('QUEUED');

    const job = await prisma.job.findUniqueOrThrow({ where: { id: result.jobId } });
    expect(job.type).toBe('website.scan');
    expect(job.businessId).toBe(context.businessId);
  });

  it('reuses an in-flight scan instead of queueing a second', async () => {
    const workspaceContext = await requireWorkspaceContext(user, workspace.id);
    const business = await createBusiness(workspaceContext, {
      name: 'Double Click Co',
      websiteUrl: 'https://example.com',
    });
    const context = await requireBusinessContext(user, business.id);

    const first = await startScan(context);
    const second = await startScan(context);

    expect(second.created).toBe(false);
    expect(second.scanRun.id).toBe(first.scanRun.id);
    expect(await prisma.scanRun.count()).toBe(1);
  });

  it('refuses when the business has no website', async () => {
    const context = await newBusiness('No Website Co');
    await expect(startScan(context)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a private address', async () => {
    const context = await newBusiness('SSRF Co');
    await expect(startScan(context, { url: 'http://169.254.169.254/' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  describe('while advertising is paused', async () => {
    /*
     * Reading your own website spends nothing, launches nothing and
     * advertises nothing. Refusing it while paused told an owner that the way
     * to look at their own site was to turn advertising back on — which is
     * the one action here that can start spending money.
     */
    const pausedBusiness = async (name: string) => {
      const workspaceContext = await requireWorkspaceContext(user, workspace.id);
      const business = await createBusiness(workspaceContext, {
        name,
        websiteUrl: 'https://example.com',
      });
      const context = await requireBusinessContext(user, business.id);
      await pauseEverything(context, { reason: 'Test' });
      return requireBusinessContext(user, business.id);
    };

    it('still refuses a scan the system decided to run', async () => {
      const context = await pausedBusiness('Paused Co');
      await expect(startScan(context)).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('reads the site when the owner asks', async () => {
      const context = await pausedBusiness('Paused But Curious');
      const result = await startScan(context, { trigger: 'OWNER' });
      expect(result.scanRun.status).toBe('QUEUED');
    });

    it('lets that scan actually run rather than cancelling it later', async () => {
      // Queued and then cancelled by the worker is worse than refused up
      // front: the button appears to work, and nothing happens minutes later.
      const context = await pausedBusiness('Paused And Queued');
      const { scanRun } = await startScan(context, { trigger: 'OWNER' });

      const job = await prisma.job.findFirstOrThrow({
        where: { businessId: context.businessId },
      });
      expect(job.payload).toMatchObject({ ownerRequested: true });

      const outcome = await runWebsiteScanJob(job.payload);
      expect(outcome).not.toMatchObject({ reason: 'business-paused' });

      const after = await prisma.scanRun.findUniqueOrThrow({ where: { id: scanRun.id } });
      expect(after.stopReason).not.toBe('business-paused');
    });

    it('cancels a queued automatic scan if a pause lands first', async () => {
      const workspaceContext = await requireWorkspaceContext(user, workspace.id);
      const business = await createBusiness(workspaceContext, {
        name: 'Paused Mid Queue',
        websiteUrl: 'https://example.com',
      });
      let context = await requireBusinessContext(user, business.id);
      const { scanRun } = await startScan(context);

      await pauseEverything(context, { reason: 'Test' });
      context = await requireBusinessContext(user, business.id);

      const job = await prisma.job.findFirstOrThrow({ where: { businessId: business.id } });
      const outcome = await runWebsiteScanJob(job.payload);

      expect(outcome).toMatchObject({ cancelled: true, reason: 'business-paused' });
      const after = await prisma.scanRun.findUniqueOrThrow({ where: { id: scanRun.id } });
      expect(after.status).toBe('CANCELLED');
    });
  });

  it('writes an audit entry and a plain-language activity entry', async () => {
    const workspaceContext = await requireWorkspaceContext(user, workspace.id);
    const business = await createBusiness(workspaceContext, {
      name: 'Audited Co',
      websiteUrl: 'https://shop.example.com',
    });
    const context = await requireBusinessContext(user, business.id);

    await startScan(context);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'website.scan_started' } });
    expect(audit?.actorId).toBe(user.id);

    const [activity] = await recentActivity(context);
    expect(activity?.message).toContain('shop.example.com');
    // No jargon in the owner-facing feed.
    expect(activity?.message).not.toMatch(/ScanRun|job|crawl/i);
  });
});

/**
 * The whole job, against a hostname that cannot be reached.
 *
 * This is the case the end-to-end run caught: the crawl finished without
 * reading anything and the scan stored as COMPLETED, so the owner saw an empty
 * Website page rather than being told their site could not be read. `.invalid`
 * is reserved by RFC 2606 and never resolves, so no packet leaves the machine.
 */
describe('a scan of a site that cannot be read', () => {
  const runJob = async (context: Awaited<ReturnType<typeof newBusiness>>) => {
    const started = await startScan(context);
    await runWebsiteScanJob({
      scanRunId: started.scanRun.id,
      businessId: context.businessId,
      requestedUrl: started.scanRun.requestedUrl,
      isRescan: false,
    });
    return started;
  };

  const unreachableBusiness = async () => {
    const workspaceContext = await requireWorkspaceContext(user, workspace.id);
    const business = await createBusiness(workspaceContext, {
      name: 'Unreachable Co',
      websiteUrl: 'https://shop.nonexistent-host-for-tests.invalid/',
    });
    return requireBusinessContext(user, business.id);
  };

  it('records the scan as failed, not completed', async () => {
    const context = await unreachableBusiness();
    // The job reports the scan's outcome by throwing, so the queue records it.
    await expect(runJob(context)).rejects.toMatchObject({ code: 'CRAWL_ERROR' });

    const scanRun = await prisma.scanRun.findFirstOrThrow({
      where: { businessId: context.businessId },
    });
    expect(scanRun.status).toBe('FAILED');
    expect(scanRun.pagesFetched).toBe(0);
  });

  it('does not retry a refusal that cannot succeed', async () => {
    const context = await unreachableBusiness();
    await expect(runJob(context)).rejects.toMatchObject({ retryable: false });
  });

  it('tells the owner it could not be read, in plain language', async () => {
    const context = await unreachableBusiness();
    await expect(runJob(context)).rejects.toThrow();

    const feed = await recentActivity(context);
    const failure = feed.find((entry) => entry.needsAttention);

    expect(failure?.message).toContain('shop.nonexistent-host-for-tests.invalid');
    expect(failure?.message).toMatch(/could not be found|could not be read/i);
    // Never a code or a stack in the owner's feed.
    expect(failure?.message).not.toMatch(/CRAWL_ERROR|ENOTFOUND|undefined/);
  });

  it('stores no website knowledge for a scan that read nothing', async () => {
    const context = await unreachableBusiness();
    await expect(runJob(context)).rejects.toThrow();

    const knowledge = await getWebsiteKnowledge(context);
    expect(knowledge?.products ?? []).toHaveLength(0);

    const status = await getScanStatus(context);
    expect(status?.phase).toBe('failed');
  });
});

describe('a shop whose products all live on one page', () => {
  /*
   * The half of this that extraction cannot prove. Products are identified by
   * the URL they were found at, so three products on one page collide on that
   * URL unless each has an identity of its own — and the failure is silent:
   * two of the three simply never appear.
   */
  it('stores each product on the page separately', async () => {
    const context = await newBusiness();
    const scanRun = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });

    await persistScan(context, scanRun.id, await crawl());

    const packs = await prisma.product.findMany({
      where: { businessId: context.businessId, productUrl: { contains: '/packs' } },
      orderBy: { priceCents: 'asc' },
    });

    expect(packs.map((p) => p.name)).toEqual(['Single', '3-Pack', 'Full Case']);
    expect(packs.map((p) => p.priceCents)).toEqual([1500, 3900, 13200]);
    // Each keeps the merchant's own identifier, so a renamed pack keeps its
    // price history instead of arriving as a new product.
    expect(packs.map((p) => p.sku)).toEqual(['single', 'three', 'case12']);
    expect(new Set(packs.map((p) => p.productUrl)).size).toBe(3);
  });

  it('keeps a single-product page identified by its bare URL', async () => {
    // Anything recorded before several-per-page existed must keep its
    // identity, or every product's price history restarts on the next scan.
    const context = await newBusiness();
    const scanRun = await prisma.scanRun.create({
      data: { businessId: context.businessId, requestedUrl: site.origin, status: 'RUNNING' },
    });

    await persistScan(context, scanRun.id, await crawl());

    const starter = await prisma.product.findFirstOrThrow({
      where: { businessId: context.businessId, name: 'Sourdough Starter' },
    });
    expect(starter.productUrl).toBe(`${site.origin}/products/sourdough-starter`);
    expect(starter.productUrl).not.toContain('#');
  });
});

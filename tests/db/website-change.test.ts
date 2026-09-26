import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User, Workspace } from '@prisma/client';
import { prisma } from '@/lib/db';
import { changeWebsite } from '@/server/business/website';
import { createBusiness } from '@/server/business/service';
import { crawlWebsite } from '@/server/scanner/crawler';
import { persistScan } from '@/server/scanner/persist';
import { startScan } from '@/server/scanner/service';
import { analyseBusiness } from '@/server/marketing/analysis';
import { createLocalWebFetchProvider } from '@/server/providers/local/web-fetch';
import { requireBusinessContext, requireWorkspaceContext } from '@/server/tenancy/context';
import { recentActivity } from '@/server/activity/feed';
import type { BusinessContext } from '@/server/tenancy/context';
import type { UrlPolicy } from '@/lib/net-safety';
import { startFixtureSite, type FixtureSite } from '../helpers/fixture-site';
import { createTestUser, createTestWorkspace, resetDatabase } from '../helpers/db';

/**
 * Changing the website address.
 *
 * The property under test is one the owner cannot check for themselves: that
 * nothing read from the old site survives to describe the new one. A leftover
 * product or fact would not look like a bug — it would look like the
 * application knowing something about their business, and it would be wrong.
 */

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

/**
 * A business that has genuinely read the fixture site.
 *
 * The stored address and the crawled one differ, which production never does.
 * That is the port guard doing its job: the fixture listens on an ephemeral
 * high port, and `assertSafePublicUrl` refuses to store anything but 80 or
 * 443 — a rule worth keeping, so the address is written past it here rather
 * than the rule being relaxed for tests. What is under test is the discarding,
 * which reads rows by business, not by URL.
 */
async function businessWithKnowledge(
  storedUrl = 'https://old.example.com',
  name = 'Alpine Bakery',
): Promise<BusinessContext> {
  const workspaceContext = await requireWorkspaceContext(user, workspace.id);
  const business = await createBusiness(workspaceContext, { name });
  await prisma.business.update({ where: { id: business.id }, data: { websiteUrl: storedUrl } });
  let context = await requireBusinessContext(user, business.id);

  const crawl = await crawlWebsite({
    startUrl: site.origin,
    fetcher: createLocalWebFetchProvider(policy),
    urlPolicy: policy,
    sleep: async () => undefined,
    limits: { minDelayMs: 0, maxPages: 50 },
  });
  const scanRun = await prisma.scanRun.create({
    data: { businessId: business.id, requestedUrl: site.origin, status: 'COMPLETED' },
  });
  await persistScan(context, scanRun.id, crawl);

  // Re-read: persistScan attached a website row the context does not know of.
  context = await requireBusinessContext(user, business.id);
  await analyseBusiness(context);

  return context;
}

describe('changeWebsite', () => {
  it('discards everything the old site taught it', async () => {
    const context = await businessWithKnowledge();
    const businessId = context.businessId;

    // Guard the guard: if the fixture stopped yielding knowledge, a passing
    // test below would prove nothing.
    expect(await prisma.product.count({ where: { businessId } })).toBeGreaterThan(0);
    expect(await prisma.businessFact.count({ where: { businessId } })).toBeGreaterThan(0);
    expect(await prisma.businessProfile.count({ where: { businessId } })).toBe(1);

    const { business, discarded } = await changeWebsite(context, 'https://example.com');

    expect(business.websiteUrl).toBe('https://example.com');
    expect(discarded.products).toBeGreaterThan(0);

    for (const count of [
      await prisma.website.count({ where: { businessId } }),
      await prisma.websitePage.count({ where: { businessId } }),
      await prisma.product.count({ where: { businessId } }),
      await prisma.businessFact.count({ where: { businessId } }),
      await prisma.businessProfile.count({ where: { businessId } }),
      await prisma.aiInference.count({ where: { businessId } }),
      await prisma.offer.count({ where: { businessId } }),
      await prisma.marketingStrategy.count({ where: { businessId } }),
      await prisma.scanRun.count({ where: { businessId } }),
    ]) {
      expect(count).toBe(0);
    }
  });

  it('keeps the record of what happened', async () => {
    const context = await businessWithKnowledge();
    const businessId = context.businessId;

    const auditBefore = await prisma.auditLog.count({ where: { businessId } });
    await changeWebsite(context, 'https://example.com');

    // History is not tidied up along with the data it describes.
    expect(await prisma.auditLog.count({ where: { businessId } })).toBeGreaterThan(auditBefore);

    const entry = await prisma.auditLog.findFirst({
      where: { businessId, action: 'business.website_changed' },
    });
    expect(entry).not.toBeNull();
    // The counts are the only surviving trace of what was removed.
    expect(entry?.newValue).toMatchObject({ websiteUrl: 'https://example.com' });
  });

  it('tells the owner what it removed, in their own terms', async () => {
    const context = await businessWithKnowledge();

    await changeWebsite(context, 'https://example.com');

    const feed = await recentActivity(context);
    const message = feed.find((item) => item.kind === 'websiteChanged')?.message ?? '';

    expect(message).toContain('example.com');
    expect(message).toMatch(/product/);
    // No jargon, and no invented certainty about what happens next.
    expect(message).not.toMatch(/scan_run|businessId|null|undefined/);
  });

  it('says so plainly when there was nothing to discard', async () => {
    const workspaceContext = await requireWorkspaceContext(user, workspace.id);
    const business = await createBusiness(workspaceContext, {
      name: 'Nothing Read Yet',
      websiteUrl: 'https://old.example.com',
    });
    const context = await requireBusinessContext(user, business.id);

    await changeWebsite(context, 'https://new.example.com');

    const message =
      (await recentActivity(context)).find((item) => item.kind === 'websiteChanged')?.message ?? '';
    expect(message).toContain('Nothing had been read');
  });

  it('clears the address when given null', async () => {
    const context = await businessWithKnowledge();

    const { business } = await changeWebsite(context, null);

    expect(business.websiteUrl).toBeNull();
    expect(await prisma.product.count({ where: { businessId: context.businessId } })).toBe(0);
  });

  it('stops a scan that is still queued', async () => {
    const workspaceContext = await requireWorkspaceContext(user, workspace.id);
    const business = await createBusiness(workspaceContext, { name: 'Mid Scan' });
    await prisma.business.update({
      where: { id: business.id },
      data: { websiteUrl: 'https://old.example.com' },
    });
    const context = await requireBusinessContext(user, business.id);
    await startScan(context, {});

    expect(await prisma.job.count({ where: { businessId: business.id, status: 'PENDING' } })).toBe(
      1,
    );

    const { discarded } = await changeWebsite(context, 'https://example.com');

    expect(discarded.cancelledScans).toBe(1);
    // Left CANCELLED rather than deleted, so the queue's history stays readable.
    expect(
      await prisma.job.count({ where: { businessId: business.id, status: 'CANCELLED' } }),
    ).toBe(1);
  });

  it('refuses an address that is not safe to fetch', async () => {
    const context = await businessWithKnowledge();

    // The same guard the crawler relies on. If this could be bypassed by
    // changing the address, every SSRF defence downstream would be moot.
    await expect(changeWebsite(context, 'http://127.0.0.1:8080/')).rejects.toThrow();
    await expect(changeWebsite(context, 'http://169.254.169.254/')).rejects.toThrow();

    // And the knowledge survives a refused change.
    expect(
      await prisma.product.count({ where: { businessId: context.businessId } }),
    ).toBeGreaterThan(0);
  });

  it('refuses a change that changes nothing', async () => {
    const context = await businessWithKnowledge('https://same.example.com');

    await expect(changeWebsite(context, 'https://same.example.com')).rejects.toThrow(/already/);
    // Nothing was discarded on the way to refusing.
    expect(
      await prisma.product.count({ where: { businessId: context.businessId } }),
    ).toBeGreaterThan(0);
  });

  it('touches only the business it was given', async () => {
    const first = await businessWithKnowledge('https://one.example.com', 'Bakery One');
    const second = await businessWithKnowledge('https://two.example.com', 'Bakery Two');

    await changeWebsite(first, 'https://example.com');

    expect(await prisma.product.count({ where: { businessId: first.businessId } })).toBe(0);
    expect(
      await prisma.product.count({ where: { businessId: second.businessId } }),
    ).toBeGreaterThan(0);
  });
});

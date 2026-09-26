import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import { archiveBusiness, createBusiness, updateBusiness } from '@/server/business/service';
import { requireBusinessContext, requireWorkspaceContext } from '@/server/tenancy/context';
import { createTestUser, createTestWorkspace, resetDatabase } from '../helpers/db';
import type { User, Workspace } from '@prisma/client';

let user: User;
let workspace: Workspace;

beforeEach(async () => {
  await resetDatabase();
  user = await createTestUser();
  workspace = await createTestWorkspace(user);
});

const context = () => requireWorkspaceContext(user, workspace.id);

describe('createBusiness', () => {
  it('cannot spend anything until setup is finished', async () => {
    // A business exists before the owner has stated a goal or a budget. Until
    // both are set, every spending path has nothing to spend against.
    const business = await createBusiness(await context(), { name: 'Anything Ltd' });
    expect(business.goal).toBeNull();
    expect(business.budgetAmountCents).toBeNull();
    expect(business.budgetPeriod).toBeNull();
  });

  it('starts on "Ask me first" rather than Autopilot', async () => {
    const business = await createBusiness(await context(), { name: 'Anything Ltd' });
    expect(business.automationMode).toBe('ASK_ME_FIRST');
  });

  it('inherits the platform spending ceilings', async () => {
    const business = await createBusiness(await context(), { name: 'Anything Ltd' });
    expect(business.maxDailyBudgetCents).toBe(2_000);
    expect(business.maxCampaignBudgetCents).toBe(10_000);
    expect(business.budgetApprovalThresholdCents).toBe(5_000);
  });

  it('accepts any industry — nothing is hard-coded to a category', async () => {
    const industries = [
      'Specialty food and beverage',
      'Industrial marine equipment',
      'Veterinary services',
      'Bespoke tailoring',
      '',
    ];

    for (const [index, industry] of industries.entries()) {
      const business = await createBusiness(await context(), {
        name: `Business ${index}`,
        industry,
      });
      expect(business.industry).toBe(industry === '' ? null : industry);
    }
  });

  it('normalises the currency to upper case', async () => {
    const business = await createBusiness(await context(), { name: 'EU Shop', currency: 'eur' });
    expect(business.currency).toBe('EUR');
  });

  it('trims whitespace and rejects an empty name', async () => {
    const business = await createBusiness(await context(), { name: '  Padded  ' });
    expect(business.name).toBe('Padded');

    await expect(createBusiness(await context(), { name: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects a website URL pointing at a private host', async () => {
    await expect(
      createBusiness(await context(), {
        name: 'SSRF attempt',
        websiteUrl: 'http://169.254.169.254/latest/meta-data/',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(await prisma.business.count()).toBe(0);
  });

  it('records an audit entry naming the human actor', async () => {
    const business = await createBusiness(await context(), { name: 'Audited Ltd' });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'business.created', businessId: business.id },
    });
    expect(entry.actorType).toBe('USER');
    expect(entry.actorId).toBe(user.id);
    expect(entry.newValue).toMatchObject({ name: 'Audited Ltd' });
  });
});

describe('updateBusiness', () => {
  it('applies changes and records before/after values', async () => {
    const created = await createBusiness(await context(), {
      name: 'Before',
      industry: 'Retail',
    });
    const businessContext = await requireBusinessContext(user, created.id);

    const updated = await updateBusiness(businessContext, { name: 'After' });
    expect(updated.name).toBe('After');

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'business.updated', businessId: created.id },
    });
    expect(entry.previousValue).toMatchObject({ name: 'Before' });
    expect(entry.newValue).toMatchObject({ name: 'After' });
  });

  it('is a no-op when nothing actually changed', async () => {
    const created = await createBusiness(await context(), { name: 'Same' });
    const businessContext = await requireBusinessContext(user, created.id);

    await updateBusiness(businessContext, { name: 'Same' });
    expect(await prisma.auditLog.count({ where: { action: 'business.updated' } })).toBe(0);
  });

  it('ignores fields outside the allow-list', async () => {
    const created = await createBusiness(await context(), { name: 'Guarded' });
    const businessContext = await requireBusinessContext(user, created.id);

    // A caller must not be able to raise its own spending cap through this path.
    await updateBusiness(businessContext, {
      name: 'Guarded',
      maxDailyBudgetCents: 999_999,
    } as never);

    const after = await prisma.business.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.maxDailyBudgetCents).toBe(2_000);
  });

  it('rejects an empty name', async () => {
    const created = await createBusiness(await context(), { name: 'Named' });
    const businessContext = await requireBusinessContext(user, created.id);

    await expect(updateBusiness(businessContext, { name: '  ' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe('archiveBusiness', () => {
  it('soft-deletes and audits rather than destroying history', async () => {
    const created = await createBusiness(await context(), { name: 'Retired' });
    const archived = await archiveBusiness(await requireBusinessContext(user, created.id));

    expect(archived.archivedAt).toBeInstanceOf(Date);
    // The row — and everything that will hang off it — is still there.
    expect(await prisma.business.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'business.archived' } })).toBe(1);
  });
});

describe('cascade behaviour', () => {
  it('removes a workspace’s businesses when the workspace is deleted', async () => {
    await createBusiness(await context(), { name: 'Doomed' });
    await prisma.workspace.delete({ where: { id: workspace.id } });

    expect(await prisma.business.count()).toBe(0);
  });

  it('keeps audit rows readable after the acting user is deleted', async () => {
    const business = await createBusiness(await context(), { name: 'Outlives its author' });
    await prisma.user.delete({ where: { id: user.id } });

    // actorId is SET NULL, not CASCADE: the record of what happened survives.
    const entry = await prisma.auditLog.findFirst({ where: { businessId: business.id } });
    expect(entry).not.toBeNull();
    expect(entry?.actorId).toBeNull();
    expect(entry?.action).toBe('business.created');
  });
});

describe('renaming a business', () => {
  /*
   * `updateBusiness` already did this; what was missing was any way to reach
   * it. Worth covering the two properties a rename must have, because the
   * name is not decoration: the free local analyser builds its placeholder
   * sentence from it, so a business set up as "Apple" while testing kept
   * saying "Apple sells products described on its own website" long after its
   * website pointed elsewhere.
   */
  it('refuses a name that is only whitespace', async () => {
    const created = await createBusiness(await context(), { name: 'Named Co' });
    const businessContext = await requireBusinessContext(user, created.id);

    await expect(updateBusiness(businessContext, { name: '   ' })).rejects.toThrow(
      /cannot be empty/i,
    );
  });

  it('keeps everything the site taught it', async () => {
    // Renaming is not repointing. Unlike changing the website, nothing read
    // from the site becomes wrong because the business is called something
    // else — so none of it may be discarded.
    const created = await createBusiness(await context(), { name: 'Before' });
    const businessContext = await requireBusinessContext(user, created.id);
    await prisma.businessFact.create({
      data: {
        businessId: created.id,
        key: 'business.name',
        value: 'Before',
        sourceUrl: 'https://example.com/',
        method: 'HTML',
        confidence: 0.8,
      },
    });

    await updateBusiness(businessContext, { name: 'After' });

    expect(await prisma.businessFact.count({ where: { businessId: created.id } })).toBe(1);
  });
});

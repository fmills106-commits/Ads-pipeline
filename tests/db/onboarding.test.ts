import { beforeEach, describe, expect, it } from 'vitest';
import type { User, Workspace } from '@prisma/client';
import { prisma } from '@/lib/db';
import { createBusiness } from '@/server/business/service';
import {
  completeOnboarding,
  isOnboarded,
  nextOnboardingStep,
  OBJECTIVE_FOR_GOAL,
} from '@/server/business/onboarding';
import {
  assertNotPaused,
  BusinessPausedError,
  isPaused,
  pauseEverything,
  resumeEverything,
} from '@/server/business/pause';
import { recentActivity } from '@/server/activity/feed';
import { requireBusinessContext, requireWorkspaceContext } from '@/server/tenancy/context';
import { createTestUser, createTestWorkspace, resetDatabase } from '../helpers/db';

let user: User;
let workspace: Workspace;

beforeEach(async () => {
  await resetDatabase();
  user = await createTestUser();
  workspace = await createTestWorkspace(user);
});

async function newBusiness(name = 'Alpine Coffee') {
  const workspaceContext = await requireWorkspaceContext(user, workspace.id);
  const business = await createBusiness(workspaceContext, { name });
  return requireBusinessContext(user, business.id);
}

describe('onboarding', () => {
  it('derives every internal limit from the stated budget', async () => {
    const context = await newBusiness();

    const business = await completeOnboarding(context, {
      goal: 'SALES',
      budgetAmountCents: 1_000,
      budgetPeriod: 'DAILY',
      automationMode: 'AUTOPILOT',
    });

    expect(business.goal).toBe('SALES');
    expect(business.budgetAmountCents).toBe(1_000);
    expect(business.budgetPeriod).toBe('DAILY');
    expect(business.automationMode).toBe('AUTOPILOT');

    // The owner typed one number; these three were worked out from it.
    expect(business.maxDailyBudgetCents).toBe(1_000);
    expect(business.maxCampaignBudgetCents).toBe(10_000);
    expect(business.budgetApprovalThresholdCents).toBe(500);
  });

  it('stores a monthly budget as stated and derives the daily figure', async () => {
    const context = await newBusiness();

    const business = await completeOnboarding(context, {
      goal: 'AWARENESS',
      budgetAmountCents: 30_000,
      budgetPeriod: 'MONTHLY',
      automationMode: 'ASK_ME_FIRST',
    });

    expect(business.budgetAmountCents).toBe(30_000);
    expect(business.budgetPeriod).toBe('MONTHLY');
    expect(business.maxDailyBudgetCents).toBe(967);
  });

  it('refuses a budget above the deployment ceiling instead of capping it', async () => {
    const context = await newBusiness();

    await expect(
      completeOnboarding(context, {
        goal: 'SALES',
        budgetAmountCents: 100_000,
        budgetPeriod: 'DAILY',
        automationMode: 'AUTOPILOT',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    // Nothing was half-applied.
    const unchanged = await prisma.business.findUniqueOrThrow({
      where: { id: context.businessId },
    });
    expect(unchanged.goal).toBeNull();
    expect(unchanged.budgetAmountCents).toBeNull();
  });

  it('tracks completion and knows which step to resume at', async () => {
    const context = await newBusiness();
    expect(isOnboarded(context.business)).toBe(false);
    expect(nextOnboardingStep(context.business)).toBe('goal');

    const business = await completeOnboarding(context, {
      goal: 'LEADS',
      budgetAmountCents: 500,
      budgetPeriod: 'DAILY',
      automationMode: 'MANUAL',
    });

    expect(isOnboarded(business)).toBe(true);
    expect(nextOnboardingStep(business)).toBe('done');
  });

  it('writes a plain-language activity entry, not a technical one', async () => {
    const context = await newBusiness();
    await completeOnboarding(context, {
      goal: 'SALES',
      budgetAmountCents: 1_000,
      budgetPeriod: 'DAILY',
      automationMode: 'AUTOPILOT',
    });

    const [entry] = await recentActivity(context);
    expect(entry?.message).toContain('get more sales');
    expect(entry?.message).toContain('$10/day');
    expect(entry?.message).toContain('Autopilot');
    // No jargon leaking into the owner-facing feed.
    expect(entry?.message).not.toMatch(/OUTCOME_|CENTS|automationMode/);
  });

  it('announces finishing setup once, however many times it is submitted', async () => {
    const context = await newBusiness();
    const answers = {
      goal: 'SALES',
      budgetAmountCents: 1_000,
      budgetPeriod: 'DAILY',
      automationMode: 'AUTOPILOT',
    } as const;

    await completeOnboarding(context, answers);
    // A double-clicked Finish button, or a form resubmitted after a slow
    // response. The write is legitimate both times; the milestone is not.
    const second = await requireBusinessContext(context.user, context.businessId);
    await completeOnboarding(second, answers);

    const milestones = (await recentActivity(context)).filter(
      (item) => item.kind === 'onboardingCompleted',
    );
    expect(milestones).toHaveLength(1);

    // The audit log still has both, because both really wrote to the business.
    expect(
      await prisma.auditLog.count({
        where: { businessId: context.businessId, action: 'business.updated' },
      }),
    ).toBe(2);
  });

  it('records the technical detail in the audit log regardless', async () => {
    const context = await newBusiness();
    await completeOnboarding(context, {
      goal: 'SALES',
      budgetAmountCents: 1_000,
      budgetPeriod: 'DAILY',
      automationMode: 'AUTOPILOT',
    });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: context.businessId, action: 'business.updated' },
    });
    expect(entry.newValue).toMatchObject({ goal: 'SALES', derivedDailyCents: 1_000 });
  });

  it('maps each owner-facing goal to exactly one campaign objective', () => {
    // The mapping is the reason the owner never types "CONVERSIONS".
    const objectives = Object.values(OBJECTIVE_FOR_GOAL);
    expect(objectives).toHaveLength(4);
    expect(new Set(objectives).size).toBe(4);
  });
});

describe('pause everything', () => {
  it('stops everything and says so in plain language', async () => {
    const context = await newBusiness();
    const paused = await pauseEverything(context, { reason: 'Paused from the dashboard.' });

    expect(isPaused(paused)).toBe(true);
    expect(paused.pausedAt).toBeInstanceOf(Date);

    const [entry] = await recentActivity(context);
    expect(entry?.message).toMatch(/paused all advertising/i);
    expect(entry?.needsAttention).toBe(true);
  });

  it('blocks any spending action while paused', async () => {
    const context = await newBusiness();
    const paused = await pauseEverything(context, { reason: 'Test' });

    expect(() => assertNotPaused(paused)).toThrow(BusinessPausedError);
  });

  it('permits spending actions once resumed', async () => {
    const context = await newBusiness();
    await pauseEverything(context, { reason: 'Test' });

    const refreshed = await requireBusinessContext(user, context.businessId);
    const resumed = await resumeEverything(refreshed);

    expect(isPaused(resumed)).toBe(false);
    expect(resumed.pauseReason).toBeNull();
    expect(() => assertNotPaused(resumed)).not.toThrow();
  });

  it('is idempotent — pausing twice changes nothing', async () => {
    const context = await newBusiness();
    const first = await pauseEverything(context, { reason: 'First' });

    const refreshed = await requireBusinessContext(user, context.businessId);
    const second = await pauseEverything(refreshed, { reason: 'Second' });

    expect(second.pausedAt?.getTime()).toBe(first.pausedAt?.getTime());
    expect(second.pauseReason).toBe('First');
    expect(await prisma.activityEvent.count({ where: { kind: 'everythingPaused' } })).toBe(1);
  });

  it('distinguishes an automatic pause from one the owner chose', async () => {
    const context = await newBusiness();
    await pauseEverything(context, {
      reason: 'A product went out of stock.',
      actor: 'SYSTEM',
    });

    const [entry] = await recentActivity(context);
    expect(entry?.message).toContain('automatically');
    expect(entry?.message).toContain('out of stock');

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'campaign.emergency_pause_all' },
    });
    expect(audit.actorType).toBe('SYSTEM');
    expect(audit.actorId).toBeNull();
  });

  it('keeps pause state isolated between businesses', async () => {
    const first = await newBusiness('First');
    const second = await newBusiness('Second');

    await pauseEverything(first, { reason: 'Only the first' });

    const stillRunning = await prisma.business.findUniqueOrThrow({
      where: { id: second.businessId },
    });
    expect(stillRunning.pausedAt).toBeNull();
  });
});

describe('activity feed isolation', () => {
  it('never shows one business’s activity under another', async () => {
    const first = await newBusiness('First');
    const second = await newBusiness('Second');

    await pauseEverything(first, { reason: 'First only' });

    expect(await recentActivity(first)).toHaveLength(1);
    expect(await recentActivity(second)).toHaveLength(0);
  });
});

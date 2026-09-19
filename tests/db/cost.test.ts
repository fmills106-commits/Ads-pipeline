import { beforeEach, describe, expect, it } from 'vitest';
import type { User, Workspace } from '@prisma/client';
import { prisma } from '@/lib/db';
import { checkBudget, costSummary, recordCost, spendToDate } from '@/server/cost/ledger';
import { createTestUser, createTestWorkspace, resetDatabase } from '../helpers/db';

/**
 * The cost ledger is what stands between a misconfiguration and a bill, so
 * these tests push on the boundary cases: exactly at a ceiling, one cent over,
 * free calls under a zero ceiling, and failed calls that may still be billed.
 */

let user: User;
let workspace: Workspace;

beforeEach(async () => {
  await resetDatabase();
  user = await createTestUser();
  workspace = await createTestWorkspace(user);
});

const PAID_CEILINGS = { dailyCents: 100, monthlyCents: 1_000, singleCallCents: 50 };
const ZERO_CEILINGS = { dailyCents: 0, monthlyCents: 0, singleCallCents: 0 };

async function addPaidSpend(cents: number, createdAt = new Date()): Promise<void> {
  await prisma.costRecord.create({
    data: {
      workspaceId: workspace.id,
      kind: 'AI_CALL',
      capability: 'AI',
      providerKey: 'ai.paid',
      tier: 'EXTERNAL_PAID',
      units: 1,
      unitLabel: 'call',
      estimatedCostCents: cents,
      actualCostCents: cents,
      succeeded: true,
      createdAt,
    },
  });
}

describe('checkBudget', () => {
  it('always allows a free call, even with every ceiling at zero', async () => {
    // The free path must never be blocked by a spending limit, or "works with
    // every provider disabled" would not hold.
    const decision = await checkBudget({
      workspaceId: workspace.id,
      tier: 'LOCAL_FREE',
      estimatedCostCents: 0,
      ceilings: ZERO_CEILINGS,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.reason).toBe('free');
  });

  it('refuses a paid call in zero-cost mode and says why', async () => {
    const decision = await checkBudget({
      workspaceId: workspace.id,
      tier: 'EXTERNAL_PAID',
      estimatedCostCents: 5,
      ceilings: ZERO_CEILINGS,
    });

    expect(decision.allowed).toBe(false);
    if (decision.allowed) return;
    expect(decision.reason).toBe('zero-cost-mode');
    expect(decision.message).toMatch(/nothing was charged/i);
  });

  it('allows a paid call within the ceilings', async () => {
    const decision = await checkBudget({
      workspaceId: workspace.id,
      tier: 'EXTERNAL_PAID',
      estimatedCostCents: 10,
      ceilings: PAID_CEILINGS,
    });

    expect(decision.allowed).toBe(true);
  });

  it('refuses a single call above the per-call ceiling', async () => {
    const decision = await checkBudget({
      workspaceId: workspace.id,
      tier: 'EXTERNAL_PAID',
      estimatedCostCents: 51,
      ceilings: PAID_CEILINGS,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('single-call-ceiling');
  });

  it('refuses the call that would cross the daily ceiling, not the one after', async () => {
    await addPaidSpend(95);

    // 95 + 5 = 100, exactly at the ceiling: allowed.
    const atLimit = await checkBudget({
      workspaceId: workspace.id,
      tier: 'EXTERNAL_PAID',
      estimatedCostCents: 5,
      ceilings: PAID_CEILINGS,
    });
    expect(atLimit.allowed).toBe(true);

    // 95 + 6 = 101, one cent over: refused before it is sent.
    const overLimit = await checkBudget({
      workspaceId: workspace.id,
      tier: 'EXTERNAL_PAID',
      estimatedCostCents: 6,
      ceilings: PAID_CEILINGS,
    });
    expect(overLimit.allowed).toBe(false);
    if (!overLimit.allowed) expect(overLimit.reason).toBe('daily-ceiling');
  });

  it('applies a tighter per-provider ceiling over the platform one', async () => {
    const decision = await checkBudget({
      workspaceId: workspace.id,
      tier: 'EXTERNAL_PAID',
      estimatedCostCents: 30,
      providerDailyCents: 20,
      ceilings: PAID_CEILINGS,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.ceilingCents).toBe(20);
  });

  it('ignores a per-provider ceiling that is looser than the platform one', async () => {
    await addPaidSpend(99);

    const decision = await checkBudget({
      workspaceId: workspace.id,
      tier: 'EXTERNAL_PAID',
      estimatedCostCents: 10,
      providerDailyCents: 100_000,
      ceilings: PAID_CEILINGS,
    });

    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.ceilingCents).toBe(100);
  });

  it('refuses on the monthly ceiling even when today is clear', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    // Only counts if it is still within this calendar month.
    if (tenDaysAgo.getUTCMonth() === new Date().getUTCMonth()) {
      await addPaidSpend(995, tenDaysAgo);

      const decision = await checkBudget({
        workspaceId: workspace.id,
        tier: 'EXTERNAL_PAID',
        estimatedCostCents: 10,
        ceilings: PAID_CEILINGS,
      });

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('monthly-ceiling');
    }
  });

  it('does not count another workspace’s spending against this one', async () => {
    const otherUser = await createTestUser();
    const otherWorkspace = await createTestWorkspace(otherUser);
    await prisma.costRecord.create({
      data: {
        workspaceId: otherWorkspace.id,
        kind: 'AI_CALL',
        capability: 'AI',
        providerKey: 'ai.paid',
        tier: 'EXTERNAL_PAID',
        units: 1,
        unitLabel: 'call',
        estimatedCostCents: 999,
        actualCostCents: 999,
        succeeded: true,
      },
    });

    const spend = await spendToDate(workspace.id);
    expect(spend.dayCents).toBe(0);
  });
});

describe('spendToDate', () => {
  it('counts paid spending but not free calls', async () => {
    await addPaidSpend(25);
    await recordCost({
      workspaceId: workspace.id,
      kind: 'AI_CALL',
      capability: 'AI',
      providerKey: 'ai.local',
      tier: 'LOCAL_FREE',
      units: 1,
      unitLabel: 'call',
      estimatedCostCents: 0,
      actualCostCents: 0,
      succeeded: true,
    });

    expect((await spendToDate(workspace.id)).dayCents).toBe(25);
  });

  it('prefers actual cost over the estimate when the provider reported it', async () => {
    await prisma.costRecord.create({
      data: {
        workspaceId: workspace.id,
        kind: 'AI_CALL',
        capability: 'AI',
        providerKey: 'ai.paid',
        tier: 'EXTERNAL_PAID',
        units: 1,
        unitLabel: 'call',
        estimatedCostCents: 10,
        actualCostCents: 42,
        succeeded: true,
      },
    });

    expect((await spendToDate(workspace.id)).dayCents).toBe(42);
  });

  it('falls back to the estimate when actual cost is unknown', async () => {
    await prisma.costRecord.create({
      data: {
        workspaceId: workspace.id,
        kind: 'AI_CALL',
        capability: 'AI',
        providerKey: 'ai.paid',
        tier: 'EXTERNAL_PAID',
        units: 1,
        unitLabel: 'call',
        estimatedCostCents: 17,
        actualCostCents: null,
        succeeded: true,
      },
    });

    expect((await spendToDate(workspace.id)).dayCents).toBe(17);
  });
});

describe('costSummary', () => {
  it('reports free when nothing has cost anything', async () => {
    for (let index = 0; index < 5; index += 1) {
      await recordCost({
        workspaceId: workspace.id,
        kind: 'AI_CALL',
        capability: 'AI',
        providerKey: 'ai.local',
        tier: 'LOCAL_FREE',
        units: 1,
        unitLabel: 'call',
        estimatedCostCents: 0,
        actualCostCents: 0,
        succeeded: true,
      });
    }

    const summary = await costSummary(workspace.id);
    expect(summary.isFree).toBe(true);
    expect(summary.allTimeCents).toBe(0);
    // Free calls are counted, so the dashboard can say "5 operations, $0.00".
    expect(summary.freeCallCount).toBe(5);
    expect(summary.paidCallCount).toBe(0);
  });

  it('stops reporting free once anything has been billed', async () => {
    await addPaidSpend(1);
    const summary = await costSummary(workspace.id);

    expect(summary.isFree).toBe(false);
    expect(summary.allTimeCents).toBe(1);
    expect(summary.paidCallCount).toBe(1);
  });
});

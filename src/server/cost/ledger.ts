import type { CostKind, ProviderCapability, ProviderTier } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { costCeilings, type CostCeilings } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { formatCents } from '@/lib/budget';

/**
 * Cost accounting.
 *
 * Two jobs: answer "may this call happen?" before it runs, and record what
 * happened after. Both are required — a check without a record drifts out of
 * date, and a record without a check is a bill you find out about later.
 *
 * Free calls are recorded too. "1,284 AI calls this month, $0.00" is the most
 * reassuring line the cost page can show, and it is only possible if the free
 * path writes rows as diligently as the paid one.
 */

export interface SpendWindow {
  dayCents: number;
  monthCents: number;
}

/** Actual cost where the provider reported it, estimate where it did not. */
const BILLED_CENTS_SQL = 'COALESCE("actualCostCents", "estimatedCostCents")';

/**
 * Paid spend so far today and this month for a workspace.
 *
 * Only `EXTERNAL_PAID` rows count: free calls never consume an allowance.
 */
export async function spendToDate(
  workspaceId: string,
  now: Date = new Date(),
  db: Db = prisma,
): Promise<SpendWindow> {
  const startOfDay = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
  );
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

  const rows = await db.$queryRawUnsafe<Array<{ day: bigint | null; month: bigint | null }>>(
    `SELECT
       SUM(${BILLED_CENTS_SQL}) FILTER (WHERE "createdAt" >= $2) AS day,
       SUM(${BILLED_CENTS_SQL}) FILTER (WHERE "createdAt" >= $3) AS month
     FROM cost_records
     WHERE "workspaceId" = $1::uuid AND "tier" = 'EXTERNAL_PAID' AND "succeeded" = true`,
    workspaceId,
    startOfDay,
    startOfMonth,
  );

  const row = rows[0];
  return {
    dayCents: Number(row?.day ?? 0),
    monthCents: Number(row?.month ?? 0),
  };
}

export interface BudgetCheckInput {
  workspaceId: string;
  tier: ProviderTier;
  estimatedCostCents: number;
  /** Optional per-provider ceilings from `provider_settings`. */
  providerDailyCents?: number | null;
  providerMonthlyCents?: number | null;
  now?: Date;
  ceilings?: CostCeilings;
  db?: Db;
}

export type BudgetDecision =
  | { allowed: true; reason: 'free' | 'within-ceilings'; spend: SpendWindow }
  | {
      allowed: false;
      reason: 'zero-cost-mode' | 'single-call-ceiling' | 'daily-ceiling' | 'monthly-ceiling';
      message: string;
      spend: SpendWindow;
      ceilingCents: number;
    };

/**
 * Decides whether a call may proceed, before it happens.
 *
 * A free call is always allowed and short-circuits — the free path must never
 * be blocked by a spending ceiling, or "the application keeps working with
 * every provider disabled" would not hold.
 */
export async function checkBudget(input: BudgetCheckInput): Promise<BudgetDecision> {
  const db = input.db ?? prisma;
  const ceilings = input.ceilings ?? costCeilings();
  const now = input.now ?? new Date();

  if (input.tier === 'LOCAL_FREE' || input.estimatedCostCents === 0) {
    return { allowed: true, reason: 'free', spend: { dayCents: 0, monthCents: 0 } };
  }

  const spend = await spendToDate(input.workspaceId, now, db);

  // In zero-cost mode every ceiling is zero, so this is the branch that catches
  // an attempted paid call — with a message that says why, not just "denied".
  if (ceilings.dailyCents === 0 && ceilings.monthlyCents === 0) {
    return {
      allowed: false,
      reason: 'zero-cost-mode',
      message:
        'This deployment is running in zero-cost mode, so paid providers are unavailable. Nothing was called and nothing was charged.',
      spend,
      ceilingCents: 0,
    };
  }

  if (input.estimatedCostCents > ceilings.singleCallCents) {
    return {
      allowed: false,
      reason: 'single-call-ceiling',
      message: `A single request estimated at ${formatCents(input.estimatedCostCents)} exceeds the ${formatCents(ceilings.singleCallCents)} per-call limit.`,
      spend,
      ceilingCents: ceilings.singleCallCents,
    };
  }

  const dailyCeiling = lowerOf(ceilings.dailyCents, input.providerDailyCents);
  if (spend.dayCents + input.estimatedCostCents > dailyCeiling) {
    return {
      allowed: false,
      reason: 'daily-ceiling',
      message: `Today's provider spending limit of ${formatCents(dailyCeiling)} has been reached.`,
      spend,
      ceilingCents: dailyCeiling,
    };
  }

  const monthlyCeiling = lowerOf(ceilings.monthlyCents, input.providerMonthlyCents);
  if (spend.monthCents + input.estimatedCostCents > monthlyCeiling) {
    return {
      allowed: false,
      reason: 'monthly-ceiling',
      message: `This month's provider spending limit of ${formatCents(monthlyCeiling)} has been reached.`,
      spend,
      ceilingCents: monthlyCeiling,
    };
  }

  return { allowed: true, reason: 'within-ceilings', spend };
}

/** The tighter of two ceilings; a null provider ceiling means "no opinion". */
function lowerOf(platform: number, provider: number | null | undefined): number {
  return provider === null || provider === undefined ? platform : Math.min(platform, provider);
}

export interface RecordCostInput {
  workspaceId: string;
  businessId?: string | null;
  kind: CostKind;
  capability: ProviderCapability;
  providerKey: string;
  tier: ProviderTier;
  model?: string | null;
  units: number;
  unitLabel: string;
  estimatedCostCents: number;
  actualCostCents?: number | null;
  subjectType?: string | null;
  subjectId?: string | null;
  succeeded: boolean;
  errorCode?: string | null;
}

/** Appends one cost row. Never updated, never deleted. */
export async function recordCost(input: RecordCostInput, db: Db = prisma): Promise<void> {
  await db.costRecord.create({
    data: {
      workspaceId: input.workspaceId,
      businessId: input.businessId ?? null,
      kind: input.kind,
      capability: input.capability,
      providerKey: input.providerKey,
      tier: input.tier,
      model: input.model ?? null,
      units: input.units,
      unitLabel: input.unitLabel,
      estimatedCostCents: input.estimatedCostCents,
      actualCostCents: input.actualCostCents ?? null,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      succeeded: input.succeeded,
      errorCode: input.errorCode ?? null,
    },
  });
}

export interface CostSummary {
  todayCents: number;
  monthCents: number;
  allTimeCents: number;
  freeCallCount: number;
  paidCallCount: number;
  ceilings: CostCeilings;
  /** True when nothing has cost anything — the normal state. */
  isFree: boolean;
}

/** What the cost page shows. */
export async function costSummary(
  workspaceId: string,
  now: Date = new Date(),
  db: Db = prisma,
): Promise<CostSummary> {
  const spend = await spendToDate(workspaceId, now, db);

  const [allTime, freeCallCount, paidCallCount] = await Promise.all([
    db.$queryRawUnsafe<Array<{ total: bigint | null }>>(
      `SELECT SUM(${BILLED_CENTS_SQL}) AS total FROM cost_records
       WHERE "workspaceId" = $1::uuid AND "tier" = 'EXTERNAL_PAID' AND "succeeded" = true`,
      workspaceId,
    ),
    db.costRecord.count({ where: { workspaceId, tier: 'LOCAL_FREE' } }),
    db.costRecord.count({ where: { workspaceId, tier: 'EXTERNAL_PAID' } }),
  ]);

  const allTimeCents = Number(allTime[0]?.total ?? 0);

  return {
    todayCents: spend.dayCents,
    monthCents: spend.monthCents,
    allTimeCents,
    freeCallCount,
    paidCallCount,
    ceilings: costCeilings(),
    isFree: allTimeCents === 0,
  };
}

/** Raised when a call is refused on cost grounds and no free fallback exists. */
export function costLimitError(decision: Extract<BudgetDecision, { allowed: false }>): AppError {
  return new AppError('BUDGET_LIMIT_EXCEEDED', `Provider call refused: ${decision.reason}`, {
    details: {
      reason: decision.reason,
      ceilingCents: decision.ceilingCents,
      spentTodayCents: decision.spend.dayCents,
    },
    publicMessage: decision.message,
  });
}

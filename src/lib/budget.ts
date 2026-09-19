/**
 * Budget arithmetic.
 *
 * The owner states a budget in whichever form is natural to them — "$10/day"
 * or "$300/month". Everything downstream needs a daily figure. This module is
 * the single place that conversion happens, and it is pure so it can be
 * exhaustively tested: a rounding error here spends real money.
 */

export type BudgetPeriodInput = 'DAILY' | 'MONTHLY';

/**
 * Days per month used for the monthly→daily conversion.
 *
 * 30.44 (365.25/12) would be more accurate on average but produces a daily
 * figure that overshoots in a 31-day month, and overshooting a stated budget
 * is the one error this system must not make. 31 means a $310/month budget
 * spends at most $10/day in every month of the year — under-spending slightly
 * in February, which is recoverable, rather than over-spending in March, which
 * is a broken promise.
 */
export const DAYS_PER_MONTH_FOR_BUDGETING = 31;

/**
 * The daily amount a stated budget permits.
 *
 * Always rounds **down**. The owner said $300/month; they must never be billed
 * for $300.01.
 */
export function dailyBudgetCents(amountCents: number, period: BudgetPeriodInput): number {
  assertValidAmount(amountCents);
  if (period === 'DAILY') return amountCents;
  return Math.floor(amountCents / DAYS_PER_MONTH_FOR_BUDGETING);
}

/** The monthly equivalent of a stated budget, for display only. */
export function monthlyBudgetCents(amountCents: number, period: BudgetPeriodInput): number {
  assertValidAmount(amountCents);
  if (period === 'MONTHLY') return amountCents;
  return amountCents * DAYS_PER_MONTH_FOR_BUDGETING;
}

export interface BudgetLimits {
  /** Platform-wide ceiling from environment configuration. */
  platformDailyCents: number;
  platformCampaignCents: number;
  platformApprovalThresholdCents: number;
}

export interface ResolvedBudget {
  /** What the owner typed, unchanged. */
  statedAmountCents: number;
  statedPeriod: BudgetPeriodInput;
  /** What the system will actually spend against, per day. */
  dailyCents: number;
  /** Derived per-business safeguards, all at or below the platform ceilings. */
  maxDailyBudgetCents: number;
  maxCampaignBudgetCents: number;
  budgetApprovalThresholdCents: number;
}

/**
 * Turns a stated budget into the internal safeguards for a business.
 *
 * This is what replaces asking the owner to configure CPA limits, campaign
 * ceilings and approval thresholds: they state one number, and every internal
 * limit is derived from it.
 *
 * Deliberately **throws** rather than clamping when the stated budget exceeds
 * the platform ceiling. Silently capping a $100/day budget at $20/day would
 * leave the owner believing they are spending five times what they are — the
 * kind of quiet mismatch this product exists to avoid. The caller surfaces the
 * ceiling and lets them choose.
 */
export function resolveBudget(
  amountCents: number,
  period: BudgetPeriodInput,
  limits: BudgetLimits,
): ResolvedBudget {
  assertValidAmount(amountCents);
  const daily = dailyBudgetCents(amountCents, period);

  if (daily < 1) {
    throw new RangeError('Budget is too small to spend anything in a day');
  }
  if (daily > limits.platformDailyCents) {
    throw new RangeError(
      `Daily budget of ${formatCents(daily)} exceeds this deployment's ceiling of ${formatCents(limits.platformDailyCents)} per day`,
    );
  }

  return {
    statedAmountCents: amountCents,
    statedPeriod: period,
    dailyCents: daily,
    maxDailyBudgetCents: daily,
    // A campaign may hold at most a month of budget at once, never more than
    // the platform allows.
    maxCampaignBudgetCents: Math.min(
      daily * DAYS_PER_MONTH_FOR_BUDGETING,
      limits.platformCampaignCents,
    ),
    // Half the daily budget is the point above which a single change is worth
    // a human glance, regardless of automation mode.
    budgetApprovalThresholdCents: Math.min(
      Math.max(Math.floor(daily / 2), 1),
      limits.platformApprovalThresholdCents,
    ),
  };
}

/**
 * The daily spend actually permitted right now: the lower of what the owner
 * asked for and what the deployment allows. Both must hold; neither alone.
 */
export function effectiveDailyCapCents(
  business: { budgetAmountCents: number | null; budgetPeriod: BudgetPeriodInput | null },
  platformDailyCents: number,
): number {
  if (business.budgetAmountCents === null || business.budgetPeriod === null) return 0;
  return Math.min(
    dailyBudgetCents(business.budgetAmountCents, business.budgetPeriod),
    platformDailyCents,
  );
}

/** `1050` → `"$10.50"`, `1000` → `"$10"`. */
export function formatCents(cents: number, currency = 'USD'): string {
  const hasFraction = cents % 100 !== 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

/** `"$10/day"` — how the owner sees their own budget echoed back. */
export function formatBudget(
  amountCents: number,
  period: BudgetPeriodInput,
  currency = 'USD',
): string {
  return `${formatCents(amountCents, currency)}/${period === 'DAILY' ? 'day' : 'month'}`;
}

/** `1000`, `1000.50` — no separators. */
const PLAIN_AMOUNT = /^\d+(\.\d{1,2})?$/;
/** `1,000`, `1,234,567.89` — commas strictly as thousands separators. */
const GROUPED_AMOUNT = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/;

/**
 * Parses a budget typed as text: `10`, `$10`, `10.50`, `$1,000`.
 * Returns cents, or null if the input is not unambiguously a number.
 *
 * A comma is accepted **only** where it is a valid thousands separator. This
 * matters more than it looks: stripping commas indiscriminately turns "10,5" —
 * how much of the world writes ten and a half — into 105, and a $10.50 budget
 * silently becomes $105. Refusing ambiguous input and asking again is the only
 * safe behaviour when the answer decides how much money gets spent.
 */
export function parseBudgetToCents(input: string): number | null {
  const cleaned = input.trim().replace(/[$\s]/g, '');
  if (cleaned === '') return null;

  const isPlain = PLAIN_AMOUNT.test(cleaned);
  const isGrouped = GROUPED_AMOUNT.test(cleaned);
  if (!isPlain && !isGrouped) return null;

  const cents = Math.round(Number(cleaned.replace(/,/g, '')) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

function assertValidAmount(amountCents: number): void {
  if (!Number.isInteger(amountCents)) {
    throw new RangeError('Budget must be an integer number of cents');
  }
  if (amountCents <= 0) {
    throw new RangeError('Budget must be greater than zero');
  }
}

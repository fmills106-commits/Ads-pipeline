import { describe, expect, it } from 'vitest';
import {
  DAYS_PER_MONTH_FOR_BUDGETING,
  dailyBudgetCents,
  effectiveDailyCapCents,
  formatBudget,
  formatCents,
  monthlyBudgetCents,
  parseBudgetToCents,
  resolveBudget,
} from '@/lib/budget';

/**
 * Budget arithmetic decides how much of someone's money gets spent, so the
 * property that matters most is tested from several directions: the derived
 * daily figure must never exceed what the owner stated.
 */

const LIMITS = {
  platformDailyCents: 2_000,
  platformCampaignCents: 10_000,
  platformApprovalThresholdCents: 5_000,
};

describe('dailyBudgetCents', () => {
  it('passes a daily budget through unchanged', () => {
    expect(dailyBudgetCents(1_000, 'DAILY')).toBe(1_000);
  });

  it('divides a monthly budget by the longest possible month', () => {
    expect(dailyBudgetCents(31_000, 'MONTHLY')).toBe(1_000);
  });

  it('always rounds down — never bill for more than was stated', () => {
    // $300/month across 31 days is $9.677…; rounding up would overspend.
    expect(dailyBudgetCents(30_000, 'MONTHLY')).toBe(967);
    expect(dailyBudgetCents(100, 'MONTHLY')).toBe(3);
  });

  it('never lets a month of daily spending exceed the stated monthly budget', () => {
    for (const monthly of [100, 999, 5_000, 30_000, 31_000, 123_456]) {
      const daily = dailyBudgetCents(monthly, 'MONTHLY');
      expect(daily * DAYS_PER_MONTH_FOR_BUDGETING).toBeLessThanOrEqual(monthly);
    }
  });

  it('rejects zero, negative and fractional amounts', () => {
    expect(() => dailyBudgetCents(0, 'DAILY')).toThrow(/greater than zero/);
    expect(() => dailyBudgetCents(-100, 'DAILY')).toThrow(/greater than zero/);
    expect(() => dailyBudgetCents(10.5, 'DAILY')).toThrow(/integer/);
  });
});

describe('monthlyBudgetCents', () => {
  it('converts in the other direction for display', () => {
    expect(monthlyBudgetCents(1_000, 'DAILY')).toBe(31_000);
    expect(monthlyBudgetCents(30_000, 'MONTHLY')).toBe(30_000);
  });
});

describe('resolveBudget', () => {
  it('derives every internal safeguard from one stated number', () => {
    const resolved = resolveBudget(1_000, 'DAILY', LIMITS);

    expect(resolved.dailyCents).toBe(1_000);
    expect(resolved.maxDailyBudgetCents).toBe(1_000);
    expect(resolved.maxCampaignBudgetCents).toBe(10_000); // clamped by platform
    expect(resolved.budgetApprovalThresholdCents).toBe(500); // half the daily
  });

  it('keeps what the owner typed, so it can be shown back to them', () => {
    const resolved = resolveBudget(30_000, 'MONTHLY', LIMITS);
    expect(resolved.statedAmountCents).toBe(30_000);
    expect(resolved.statedPeriod).toBe('MONTHLY');
    expect(resolved.dailyCents).toBe(967);
  });

  it('never derives a safeguard above the platform ceiling', () => {
    const resolved = resolveBudget(2_000, 'DAILY', LIMITS);
    expect(resolved.maxDailyBudgetCents).toBeLessThanOrEqual(LIMITS.platformDailyCents);
    expect(resolved.maxCampaignBudgetCents).toBeLessThanOrEqual(LIMITS.platformCampaignCents);
    expect(resolved.budgetApprovalThresholdCents).toBeLessThanOrEqual(
      LIMITS.platformApprovalThresholdCents,
    );
  });

  it('refuses rather than silently capping a budget above the ceiling', () => {
    // Quietly spending $20/day on a stated $100/day budget would leave the
    // owner believing something false about their own account.
    expect(() => resolveBudget(10_000, 'DAILY', LIMITS)).toThrow(/exceeds this deployment/);
  });

  it('names both the request and the ceiling when it refuses', () => {
    let message = '';
    try {
      resolveBudget(10_000, 'DAILY', LIMITS);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('$100');
    expect(message).toContain('$20');
  });

  it('refuses a budget too small to spend anything in a day', () => {
    expect(() => resolveBudget(20, 'MONTHLY', LIMITS)).toThrow(/too small/);
  });

  it('keeps the approval threshold at least one cent', () => {
    expect(resolveBudget(1, 'DAILY', LIMITS).budgetApprovalThresholdCents).toBe(1);
  });
});

describe('effectiveDailyCapCents', () => {
  it('takes the lower of the stated budget and the platform ceiling', () => {
    expect(effectiveDailyCapCents({ budgetAmountCents: 500, budgetPeriod: 'DAILY' }, 2_000)).toBe(
      500,
    );
    expect(effectiveDailyCapCents({ budgetAmountCents: 9_000, budgetPeriod: 'DAILY' }, 2_000)).toBe(
      2_000,
    );
  });

  it('permits nothing before setup is finished', () => {
    expect(effectiveDailyCapCents({ budgetAmountCents: null, budgetPeriod: null }, 2_000)).toBe(0);
    expect(effectiveDailyCapCents({ budgetAmountCents: 500, budgetPeriod: null }, 2_000)).toBe(0);
  });
});

describe('parseBudgetToCents', () => {
  it('accepts the shapes people actually type', () => {
    expect(parseBudgetToCents('10')).toBe(1_000);
    expect(parseBudgetToCents('$10')).toBe(1_000);
    expect(parseBudgetToCents(' 12.50 ')).toBe(1_250);
    expect(parseBudgetToCents('$1,000')).toBe(100_000);
  });

  it('rejects anything it cannot read exactly', () => {
    for (const input of ['', 'ten', '10.999', '-5', '0', '1e5', '1,00', '1,0000', '10.5.2']) {
      expect(parseBudgetToCents(input), input).toBeNull();
    }
  });

  it('rejects a decimal comma rather than guessing', () => {
    // Much of the world writes ten and a half as "10,5". Stripping the comma
    // would read that as 105 — a tenfold overspend from a plausible typo.
    expect(parseBudgetToCents('10,5')).toBeNull();
    expect(parseBudgetToCents('10,50')).toBeNull();
  });

  it('accepts a comma only as a genuine thousands separator', () => {
    expect(parseBudgetToCents('1,000')).toBe(100_000);
    expect(parseBudgetToCents('1,234,567.89')).toBe(123_456_789);
  });
});

describe('formatting', () => {
  it('omits cents when there are none', () => {
    expect(formatCents(1_000)).toBe('$10');
    expect(formatCents(1_050)).toBe('$10.50');
    expect(formatCents(0)).toBe('$0');
  });

  it('echoes a budget in the owner’s own terms', () => {
    expect(formatBudget(1_000, 'DAILY')).toBe('$10/day');
    expect(formatBudget(30_000, 'MONTHLY')).toBe('$300/month');
  });
});

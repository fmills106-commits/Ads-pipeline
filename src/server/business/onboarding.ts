import type { AutomationMode, Business, BudgetPeriod, BusinessGoal } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { validationError } from '@/lib/errors';
import { formatBudget, resolveBudget } from '@/lib/budget';
import { AUDIT_ACTIONS, recordAudit } from '@/server/audit/log';
import { recordActivity } from '@/server/activity/feed';
import type { BusinessContext } from '@/server/tenancy/context';

/**
 * Onboarding: the four questions a business owner answers.
 *
 *   1. What is your business?   (name + website)
 *   2. What do you want?        (goal)
 *   3. What can you spend?      (budget)
 *   4. How involved do you want to be?  (automation)
 *
 * Everything else — campaign objectives, bid strategies, approval thresholds,
 * campaign ceilings, creative refresh cadence, provider routing — is derived
 * or defaulted here. The owner never sees a CPA target or a ROAS threshold,
 * because the system sets those from what they told us.
 */

/** The owner-facing goals, with the exact wording used in the UI. */
export const GOAL_CHOICES = [
  {
    value: 'SALES',
    label: 'Get more sales',
    help: 'Best if people buy directly on your website.',
  },
  {
    value: 'LEADS',
    label: 'Get more leads',
    help: 'Best if people enquire first and buy later.',
  },
  {
    value: 'CUSTOMERS',
    label: 'Get more customers',
    help: 'Best if you want new people, not repeat buyers.',
  },
  {
    value: 'AWARENESS',
    label: 'Grow awareness',
    help: 'Best if you want more people to know you exist.',
  },
] as const satisfies ReadonlyArray<{ value: BusinessGoal; label: string; help: string }>;

/** The three automation choices. Not a scale of safety — see below. */
export const AUTOMATION_CHOICES = [
  {
    value: 'AUTOPILOT',
    label: 'Autopilot',
    help: 'The AI runs your advertising within your budget, and still asks whenever something important is uncertain.',
  },
  {
    value: 'ASK_ME_FIRST',
    label: 'Ask me first',
    help: 'The AI prepares everything and checks with you before anything goes live.',
    recommended: true,
  },
  {
    value: 'MANUAL',
    label: 'Manual',
    help: 'The AI suggests ads and creatives. You approve every action yourself.',
  },
] as const satisfies ReadonlyArray<{
  value: AutomationMode;
  label: string;
  help: string;
  recommended?: boolean;
}>;

/**
 * The internal campaign objective for each goal.
 *
 * This mapping is the whole reason the owner never types "CONVERSIONS": they
 * say what they want in their own words, and the translation happens once,
 * here, where it can be reviewed.
 */
export const OBJECTIVE_FOR_GOAL: Record<BusinessGoal, string> = {
  SALES: 'OUTCOME_SALES',
  LEADS: 'OUTCOME_LEADS',
  CUSTOMERS: 'OUTCOME_TRAFFIC',
  AWARENESS: 'OUTCOME_AWARENESS',
};

export interface CompleteOnboardingInput {
  goal: BusinessGoal;
  budgetAmountCents: number;
  budgetPeriod: BudgetPeriod;
  automationMode: AutomationMode;
}

/**
 * Finishes onboarding, deriving every internal safeguard from the stated budget.
 *
 * @throws {AppError} VALIDATION_ERROR when the budget is unusable or exceeds
 * what this deployment permits. Deliberately not clamped: quietly capping a
 * $100/day budget at $20/day would leave the owner believing they are spending
 * five times what they are.
 */
export async function completeOnboarding(
  context: BusinessContext,
  input: CompleteOnboardingInput,
  db: Db = prisma,
): Promise<Business> {
  const env = getEnv();

  let budget;
  try {
    budget = resolveBudget(input.budgetAmountCents, input.budgetPeriod, {
      platformDailyCents: env.MAX_DAILY_BUDGET_CENTS,
      platformCampaignCents: env.MAX_CAMPAIGN_BUDGET_CENTS,
      platformApprovalThresholdCents: env.BUDGET_APPROVAL_THRESHOLD_CENTS,
    });
  } catch (cause) {
    throw validationError('Budget is not usable', {
      publicMessage: cause instanceof Error ? cause.message : 'That budget cannot be used.',
      cause,
    });
  }

  const updated = await db.business.update({
    where: { id: context.businessId },
    data: {
      goal: input.goal,
      budgetAmountCents: budget.statedAmountCents,
      budgetPeriod: input.budgetPeriod,
      automationMode: input.automationMode,
      maxDailyBudgetCents: budget.maxDailyBudgetCents,
      maxCampaignBudgetCents: budget.maxCampaignBudgetCents,
      budgetApprovalThresholdCents: budget.budgetApprovalThresholdCents,
    },
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: updated.id,
      actorType: 'USER',
      actorId: context.user.id,
      action: AUDIT_ACTIONS.businessUpdated,
      objectType: 'Business',
      objectId: updated.id,
      newValue: {
        goal: input.goal,
        budgetAmountCents: budget.statedAmountCents,
        budgetPeriod: input.budgetPeriod,
        automationMode: input.automationMode,
        derivedDailyCents: budget.dailyCents,
      },
    },
    db,
  );

  const goalLabel = GOAL_CHOICES.find((choice) => choice.value === input.goal)?.label ?? input.goal;
  const automationLabel =
    AUTOMATION_CHOICES.find((choice) => choice.value === input.automationMode)?.label ??
    input.automationMode;

  await recordActivity(
    { ...context, business: updated },
    {
      kind: 'onboardingCompleted',
      message: `Set up to ${goalLabel.toLowerCase()} on ${formatBudget(
        budget.statedAmountCents,
        input.budgetPeriod,
        updated.currency,
      )}, running on ${automationLabel}.`,
      detail: { dailyBudgetCents: budget.dailyCents },
    },
    db,
  );

  return updated;
}

/** True once the owner has answered all four questions. */
export const isOnboarded = (business: Business): boolean =>
  business.goal !== null && business.budgetAmountCents !== null && business.budgetPeriod !== null;

/** Which onboarding step to resume at. */
export function nextOnboardingStep(business: Business): 'goal' | 'budget' | 'done' {
  if (business.goal === null) return 'goal';
  if (business.budgetAmountCents === null || business.budgetPeriod === null) return 'budget';
  return 'done';
}

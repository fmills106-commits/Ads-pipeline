import { z } from 'zod';
import { route } from '@/server/api/handler';
import { completeOnboarding } from '@/server/business/onboarding';
import { requireBusinessContext } from '@/server/tenancy/context';
import { validationError } from '@/lib/errors';

const schema = z.object({
  goal: z.enum(['SALES', 'LEADS', 'CUSTOMERS', 'AWARENESS']),
  budgetAmountCents: z.number().int().positive().max(100_000_000),
  budgetPeriod: z.enum(['DAILY', 'MONTHLY']),
  automationMode: z.enum(['AUTOPILOT', 'ASK_ME_FIRST', 'MANUAL']),
});

/** POST /api/businesses/:businessId/onboarding — steps 2-4, submitted together. */
export const POST = route({ schema }, async ({ body, params, user }) => {
  const businessId = params.businessId;
  if (typeof businessId !== 'string') throw validationError('businessId is required');

  const context = await requireBusinessContext(user, businessId, { minimumRole: 'MEMBER' });
  const business = await completeOnboarding(context, body);

  return {
    id: business.id,
    goal: business.goal,
    budgetAmountCents: business.budgetAmountCents,
    budgetPeriod: business.budgetPeriod,
    automationMode: business.automationMode,
    dailyBudgetCents: business.maxDailyBudgetCents,
  };
});

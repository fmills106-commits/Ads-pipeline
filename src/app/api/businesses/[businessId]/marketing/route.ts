import { z } from 'zod';
import { validationError } from '@/lib/errors';
import { route } from '@/server/api/handler';
import { RATE_LIMITS } from '@/server/api/rate-limit';
import { analyseBusiness, getAnalysis } from '@/server/marketing/analysis';
import { generateAdCopy, generateStrategies } from '@/server/marketing/engine';
import { createOffers, proposeOffers } from '@/server/marketing/offers';
import { requireBusinessContext } from '@/server/tenancy/context';

/**
 * The marketing engine's one endpoint.
 *
 * A single action-dispatched route rather than four, because each of these is
 * the same shape — take a business context, run one engine step, return what
 * changed — and four near-identical files would drift apart.
 *
 * Every action costs an AI call, so they share the `scan` rate limit rather
 * than the generous API backstop: these are the expensive buttons.
 */

const schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('analyse') }),
  z.object({ action: z.literal('strategies'), productId: z.string().uuid() }),
  z.object({ action: z.literal('copy'), strategyId: z.string().uuid() }),
  z.object({ action: z.literal('offers') }),
]);

export const POST = route(
  { schema, rateLimit: RATE_LIMITS.marketing },
  async ({ body, params, user }) => {
    const businessId = params['businessId'];
    if (typeof businessId !== 'string') throw validationError('businessId is required');

    const context = await requireBusinessContext(user, businessId);

    switch (body.action) {
      case 'analyse':
        return analyseBusiness(context);

      case 'strategies':
        return generateStrategies(context, body.productId);

      case 'copy':
        return generateAdCopy(context, body.strategyId);

      case 'offers': {
        // Proposed and saved in one step, but saved as PROPOSED — nothing
        // becomes active without a person approving it.
        const { proposals, skipped } = await proposeOffers(context);
        const created = await createOffers(context, proposals, null);
        return { created, skipped };
      }
    }
  },
);

/** GET — the current reading of this business. */
export const GET = route({}, async ({ params, user }) => {
  const businessId = params['businessId'];
  if (typeof businessId !== 'string') throw validationError('businessId is required');

  const context = await requireBusinessContext(user, businessId);
  return getAnalysis(context);
});

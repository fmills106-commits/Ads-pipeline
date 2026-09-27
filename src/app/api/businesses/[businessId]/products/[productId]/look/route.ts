import { validationError } from '@/lib/errors';
import { route } from '@/server/api/handler';
import { describeProductLook } from '@/server/marketing/engine';
import { requireBusinessContext } from '@/server/tenancy/context';

/**
 * POST /api/businesses/:businessId/products/:productId/look
 *
 * Writes down what this product looks like, from its own photographs.
 *
 * A POST with no body, because the answer depends on nothing the caller
 * supplies: the product, its pictures and its page are already known. What the
 * owner is asking for is the work, not a change to it.
 *
 * MEMBER rather than ADMIN, matching the other things that generate rather than
 * spend: whether this costs anything at all is decided by the three switches in
 * front of the paid writer, not by who pressed the button.
 */
export const POST = route({}, async ({ params, user }) => {
  const businessId = params.businessId;
  const productId = params.productId;
  if (typeof businessId !== 'string') throw validationError('businessId is required');
  if (typeof productId !== 'string') throw validationError('productId is required');

  const context = await requireBusinessContext(user, businessId, { minimumRole: 'MEMBER' });
  const result = await describeProductLook(context, productId);

  return {
    brief: result.brief,
    seen: result.seen,
    simulated: result.simulated,
    decisionId: result.decisionId,
  };
});

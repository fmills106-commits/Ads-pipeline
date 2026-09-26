import { z } from 'zod';
import { validationError } from '@/lib/errors';
import { route } from '@/server/api/handler';
import { setProductDetails } from '@/server/business/product-details';
import { requireBusinessContext } from '@/server/tenancy/context';

/**
 * PATCH /api/businesses/:businessId/products/:productId
 *
 * The owner's own words about a product, and what it costs them. Both are
 * things no page states, so neither can be scraped or inferred — and until
 * this existed there was no way to supply them, which left the engine writing
 * advertisements from a name and a price.
 *
 * Cost arrives in whole cents. A float that reaches a margin calculation and
 * gets rounded somewhere downstream is a number nobody can reason about.
 */
const schema = z.object({
  ownerDescription: z.string().max(2000).nullable().optional(),
  costCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
});

export const PATCH = route({ schema }, async ({ body, params, user }) => {
  const businessId = params.businessId;
  const productId = params.productId;
  if (typeof businessId !== 'string') throw validationError('businessId is required');
  if (typeof productId !== 'string') throw validationError('productId is required');

  const context = await requireBusinessContext(user, businessId, { minimumRole: 'MEMBER' });

  const product = await setProductDetails(context, productId, {
    ...(body.ownerDescription === undefined ? {} : { ownerDescription: body.ownerDescription }),
    ...(body.costCents === undefined ? {} : { costCents: body.costCents }),
  });

  return {
    id: product.id,
    ownerDescription: product.ownerDescription,
    costCents: product.costCents,
  };
});

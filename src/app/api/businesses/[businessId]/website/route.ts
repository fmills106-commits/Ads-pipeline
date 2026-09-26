import { z } from 'zod';
import { route } from '@/server/api/handler';
import { changeWebsite } from '@/server/business/website';
import { requireBusinessContext } from '@/server/tenancy/context';
import { validationError } from '@/lib/errors';

/*
 * `null` clears the address; a string sets it. The field is required so that
 * clearing is something the caller asked for, rather than what happens when a
 * key is forgotten.
 */
const schema = z.object({
  websiteUrl: z.string().trim().url('Enter a full web address, including https://').nullable(),
});

const businessIdFrom = (params: Record<string, unknown>): string => {
  const businessId = params['businessId'];
  if (typeof businessId !== 'string') throw validationError('businessId is required');
  return businessId;
};

/**
 * PUT /api/businesses/:businessId/website — change or clear the address.
 *
 * Requires MEMBER, the same as the rest of the business's configuration. The
 * work is destructive by necessity — see `changeWebsite` — so it is a
 * deliberate write, never a side effect of viewing anything.
 */
export const PUT = route({ schema }, async ({ body, params, user }) => {
  const context = await requireBusinessContext(user, businessIdFrom(params), {
    minimumRole: 'MEMBER',
  });
  const { business, discarded } = await changeWebsite(context, body.websiteUrl);

  return { id: business.id, websiteUrl: business.websiteUrl, discarded };
});

/** DELETE /api/businesses/:businessId/website — the same thing, via the verb. */
export const DELETE = route({}, async ({ params, user }) => {
  const context = await requireBusinessContext(user, businessIdFrom(params), {
    minimumRole: 'MEMBER',
  });
  const { business, discarded } = await changeWebsite(context, null);

  return { id: business.id, websiteUrl: business.websiteUrl, discarded };
});

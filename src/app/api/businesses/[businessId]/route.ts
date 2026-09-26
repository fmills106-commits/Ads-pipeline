import { z } from 'zod';
import { route } from '@/server/api/handler';
import { archiveBusiness, updateBusiness } from '@/server/business/service';
import { requireBusinessContext } from '@/server/tenancy/context';
import { validationError } from '@/lib/errors';

/**
 * DELETE /api/businesses/:businessId — start over.
 *
 * Archives rather than deletes. The owner's intent ("get this off my screen
 * and let me set up properly") is served either way, and archiving keeps the
 * audit trail, the cost history and the ability to answer what happened, at
 * the price of some rows nobody will look at. Deleting a business to tidy the
 * interface would destroy the record of every decision made for it.
 *
 * ADMIN, not MEMBER: this removes a whole business from everyone's view, which
 * is not symmetric with pausing. The person who created the workspace is its
 * OWNER, so an owner clearing their own first attempt is unaffected.
 */
export const DELETE = route({}, async ({ params, user }) => {
  const businessId = params.businessId;
  if (typeof businessId !== 'string') throw validationError('businessId is required');

  const context = await requireBusinessContext(user, businessId, { minimumRole: 'ADMIN' });
  const business = await archiveBusiness(context);

  return { id: business.id, archivedAt: business.archivedAt?.toISOString() ?? null };
});

const patchSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
});

/**
 * PATCH /api/businesses/:businessId — rename.
 *
 * The name is not decoration. It is what the free local analyser builds its
 * placeholder sentence from, so a business set up as "Apple" while testing
 * kept saying "Apple sells products described on its own website" long after
 * its website pointed somewhere else — which reads like stale analysis rather
 * than a name nobody could change.
 *
 * `updateBusiness` already validated, allow-listed and audited this field; all
 * that was missing was a way to reach it.
 */
export const PATCH = route({ schema: patchSchema }, async ({ body, params, user }) => {
  const businessId = params.businessId;
  if (typeof businessId !== 'string') throw validationError('businessId is required');

  const context = await requireBusinessContext(user, businessId, { minimumRole: 'MEMBER' });
  const business = await updateBusiness(context, { name: body.name });

  return { id: business.id, name: business.name };
});

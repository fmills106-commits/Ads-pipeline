import { route } from '@/server/api/handler';
import { archiveBusiness } from '@/server/business/service';
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

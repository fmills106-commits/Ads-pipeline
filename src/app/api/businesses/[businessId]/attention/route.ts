import { validationError } from '@/lib/errors';
import { route } from '@/server/api/handler';
import { resolveAttention } from '@/server/activity/feed';
import { requireBusinessContext } from '@/server/tenancy/context';

/**
 * POST /api/businesses/:businessId/attention — mark the open items handled.
 *
 * The automatic resolution can only answer conditions whose clearing some code
 * noticed: a scan succeeding answers a scan failure, resuming answers a pause.
 * Anything flagged by something that does not happen again has no such moment,
 * and stayed on the dashboard permanently — which is exactly how a real
 * deployment ended up insisting three things needed input after all three had
 * been dealt with.
 *
 * Nothing is deleted. The entries stay in the feed, because they happened;
 * they just stop asking.
 */
export const POST = route({}, async ({ params, user }) => {
  const businessId = params.businessId;
  if (typeof businessId !== 'string') throw validationError('businessId is required');

  const context = await requireBusinessContext(user, businessId, { minimumRole: 'MEMBER' });
  const resolved = await resolveAttention(context);

  return { resolved };
});

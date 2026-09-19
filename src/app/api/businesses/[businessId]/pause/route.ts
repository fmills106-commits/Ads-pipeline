import { z } from 'zod';
import { route } from '@/server/api/handler';
import { pauseEverything, resumeEverything } from '@/server/business/pause';
import { requireBusinessContext } from '@/server/tenancy/context';
import { validationError } from '@/lib/errors';

const schema = z.object({
  action: z.enum(['pause', 'resume']),
  reason: z.string().trim().max(200).optional(),
});

/**
 * POST /api/businesses/:businessId/pause — the emergency control.
 *
 * MEMBER is enough to pause: stopping spending must never be blocked on
 * finding someone with a higher role. Resuming requires the same, since it is
 * the reverse of an action the same person could take.
 */
export const POST = route({ schema }, async ({ body, params, user }) => {
  const businessId = params.businessId;
  if (typeof businessId !== 'string') throw validationError('businessId is required');

  const context = await requireBusinessContext(user, businessId, { minimumRole: 'MEMBER' });

  const business =
    body.action === 'pause'
      ? await pauseEverything(context, {
          reason: body.reason ?? 'Paused from the dashboard.',
          actor: 'USER',
        })
      : await resumeEverything(context);

  return {
    id: business.id,
    paused: business.pausedAt !== null,
    pausedAt: business.pausedAt?.toISOString() ?? null,
    pauseReason: business.pauseReason,
  };
});

import { z } from 'zod';
import { validationError } from '@/lib/errors';
import { route } from '@/server/api/handler';
import { setProviderEnabled } from '@/server/providers/settings';
import { requireWorkspaceContext } from '@/server/tenancy/context';

/**
 * Switching a paid service on or off for a workspace.
 *
 * ADMIN, not MEMBER. Every other setting here shapes advertising; this one
 * decides whether the application may spend money on its own behalf, and that
 * is not symmetric with choosing a budget or pausing a campaign.
 *
 * Limits arrive in whole cents rather than dollars, because a float that
 * arrives as 4.9999999 and is rounded somewhere downstream is a spending
 * ceiling nobody can reason about.
 */
const schema = z.object({
  providerKey: z.string().min(1).max(100),
  enabled: z.boolean(),
  maxDailyCostCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
  maxMonthlyCostCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
});

export const PUT = route({ schema }, async ({ body, params, user }) => {
  const workspaceId = params.workspaceId;
  if (typeof workspaceId !== 'string') throw validationError('workspaceId is required');

  const context = await requireWorkspaceContext(user, workspaceId, { minimumRole: 'ADMIN' });

  const setting = await setProviderEnabled(context, {
    providerKey: body.providerKey,
    enabled: body.enabled,
    ...(body.maxDailyCostCents === undefined ? {} : { maxDailyCostCents: body.maxDailyCostCents }),
    ...(body.maxMonthlyCostCents === undefined
      ? {}
      : { maxMonthlyCostCents: body.maxMonthlyCostCents }),
  });

  return {
    providerKey: setting.providerKey,
    enabled: setting.enabled,
    maxDailyCostCents: setting.maxDailyCostCents,
    maxMonthlyCostCents: setting.maxMonthlyCostCents,
  };
});

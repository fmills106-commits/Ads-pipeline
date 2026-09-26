import { z } from 'zod';
import { validationError } from '@/lib/errors';
import { route } from '@/server/api/handler';
import { setProviderKey } from '@/server/providers/settings';
import { requireWorkspaceContext } from '@/server/tenancy/context';

/**
 * Storing, replacing or removing a workspace's own API key.
 *
 * ADMIN, like switching the provider on: a key is the means to spend, and
 * handing it to a member who can be added to a workspace by anyone would make
 * the role boundary meaningless.
 *
 * `apiKey: null` removes the stored key. One route for both because they are the
 * same decision — which key this workspace uses, if any — and because a removal
 * that lived somewhere else would be the one call an owner could not find in a
 * hurry.
 *
 * The response carries the hint and never the key. There is no GET here at all:
 * a stored key has no read path, from the browser or anywhere else.
 */
const schema = z.object({
  providerKey: z.string().min(1).max(100),
  // Bounds only. The shape of an API key is Anthropic's business and changes
  // without notice; `setProviderKey` rejects what is certainly not a key.
  apiKey: z.string().min(1).max(500).nullable(),
});

export const PUT = route({ schema }, async ({ body, params, user }) => {
  const workspaceId = params.workspaceId;
  if (typeof workspaceId !== 'string') throw validationError('workspaceId is required');

  const context = await requireWorkspaceContext(user, workspaceId, { minimumRole: 'ADMIN' });

  const state = await setProviderKey(context, {
    providerKey: body.providerKey,
    apiKey: body.apiKey,
  });

  return state;
});

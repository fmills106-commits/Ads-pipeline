import { cookies } from 'next/headers';
import type { Business, User } from '@prisma/client';
import { listBusinesses } from '@/server/business/service';
import { requireWorkspaceContext, type WorkspaceContext } from '@/server/tenancy/context';
import { listWorkspacesForUser } from '@/server/tenancy/context';

/**
 * Which business the screens are about.
 *
 * Every page took `businesses[0]`, so a workspace with two websites could only
 * ever reach the first — the schema, the tenancy layer and every table have
 * been per-business since Phase 1, and the interface quietly assumed one.
 *
 * The choice lives in a cookie rather than the URL. A cookie is a smaller
 * change than re-homing every route under `/b/[businessId]/…`, and the routes
 * are not shared or bookmarked per business yet. The trade is real and worth
 * naming: two browser tabs cannot show two different businesses, and a link to
 * "the dashboard" means "whichever I last chose". If either becomes a problem,
 * the URL is the answer and this function is the single place that changes.
 *
 * What the cookie can never do is grant access. It is a *preference*, read and
 * then checked: a business id that is not in this workspace's own list is
 * ignored and the first is used instead. So pasting somebody else's id changes
 * nothing — the list comes from the workspace, and the workspace comes from
 * the session.
 */

export const ACTIVE_BUSINESS_COOKIE = 'business';

export interface ActiveBusiness {
  workspaceContext: WorkspaceContext;
  /** Every business in the workspace, for the switcher. */
  businesses: Business[];
  /** The chosen one, or null when the workspace has none yet. */
  business: Business | null;
}

export interface NoWorkspace {
  workspaceContext: null;
  businesses: [];
  business: null;
}

/**
 * Resolves the workspace, its businesses, and which one is active.
 *
 * One function so the four screens cannot drift apart on what "the current
 * business" means — which is exactly how three of them ended up saying
 * "Settings" for something that lived on a fourth.
 */
export async function resolveActiveBusiness(user: User): Promise<ActiveBusiness | NoWorkspace> {
  const workspaces = await listWorkspacesForUser(user);
  const active = workspaces[0];
  if (!active) return { workspaceContext: null, businesses: [], business: null };

  const workspaceContext = await requireWorkspaceContext(user, active.workspace.id);
  const businesses = await listBusinesses(workspaceContext);

  const requested = (await cookies()).get(ACTIVE_BUSINESS_COOKIE)?.value;

  return {
    workspaceContext,
    businesses,
    business: chooseActiveBusiness(businesses, requested),
  };
}

/**
 * Picks the active business from the ones this workspace actually has.
 *
 * Separate and pure so the property that matters can be tested without a
 * request: **the cookie is a preference, not a capability.** The candidate
 * list is built from the workspace, the workspace comes from the session, and
 * an id that is not in the list simply loses — so pasting another account's
 * business id selects nothing.
 */
export function chooseActiveBusiness(
  businesses: Business[],
  requestedId: string | undefined,
): Business | null {
  return businesses.find((business) => business.id === requestedId) ?? businesses[0] ?? null;
}

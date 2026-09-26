'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { requireCurrentUser } from '@/server/auth/current-user';
import { listBusinesses } from '@/server/business/service';
import { listWorkspacesForUser, requireWorkspaceContext } from '@/server/tenancy/context';
import { ACTIVE_BUSINESS_COOKIE } from '@/server/tenancy/active-business';

/**
 * Switches which business the screens are about.
 *
 * Validated before it is stored, not just when it is read. Storing an id this
 * user has no access to would be harmless — `resolveActiveBusiness` checks
 * again against the workspace's own list — but it would leave a cookie that
 * silently does nothing, and "I clicked it and nothing changed" is a worse bug
 * than an error.
 */
export async function switchBusiness(formData: FormData): Promise<void> {
  const requested = formData.get('businessId');
  if (typeof requested !== 'string' || requested === '') return;

  const user = await requireCurrentUser();
  const workspaces = await listWorkspacesForUser(user);
  const active = workspaces[0];
  if (!active) return;

  const context = await requireWorkspaceContext(user, active.workspace.id);
  const businesses = await listBusinesses(context);
  if (!businesses.some((business) => business.id === requested)) return;

  (await cookies()).set(ACTIVE_BUSINESS_COOKIE, requested, {
    maxAge: 60 * 60 * 24 * 365,
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  });

  revalidatePath('/', 'layout');
}

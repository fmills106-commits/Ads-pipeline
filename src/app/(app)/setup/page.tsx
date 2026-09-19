import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireCurrentUser } from '@/server/auth/current-user';
import { listWorkspacesForUser, requireWorkspaceContext } from '@/server/tenancy/context';
import { listBusinesses } from '@/server/business/service';
import { isOnboarded } from '@/server/business/onboarding';
import { getEnv } from '@/lib/env';
import { SetupWizard } from './setup-wizard';

export const metadata: Metadata = { title: 'Set up' };

/**
 * The whole setup, on one page.
 *
 * Four questions. No settings, no thresholds, no provider choices — the
 * business owner answers what they already know about their own business and
 * the system derives everything else.
 */
export default async function SetupPage() {
  const user = await requireCurrentUser();
  const workspaces = await listWorkspacesForUser(user);
  const active = workspaces[0];
  if (!active) redirect('/dashboard');

  const context = await requireWorkspaceContext(user, active.workspace.id);
  const businesses = await listBusinesses(context);

  // Already finished? There is nothing to set up.
  const unfinished = businesses.find((business) => !isOnboarded(business));
  if (businesses.length > 0 && !unfinished) redirect('/dashboard');

  const env = getEnv();

  return (
    <SetupWizard
      workspaceId={active.workspace.id}
      existingBusiness={
        unfinished
          ? { id: unfinished.id, name: unfinished.name, websiteUrl: unfinished.websiteUrl }
          : null
      }
      maxDailyBudgetCents={env.MAX_DAILY_BUDGET_CENTS}
    />
  );
}

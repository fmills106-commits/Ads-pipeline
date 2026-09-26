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
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireCurrentUser();
  const workspaces = await listWorkspacesForUser(user);
  const active = workspaces[0];
  if (!active) redirect('/dashboard');

  const context = await requireWorkspaceContext(user, active.workspace.id);
  const businesses = await listBusinesses(context);

  /*
   * `?another=1` is how an owner adds a second website.
   *
   * Without it this page sends a finished workspace to the dashboard, which
   * was right while one business was all there could be and is now the thing
   * that made a second unreachable. The flag says "I know, I want another
   * one", so an unfinished business is not resumed either: resuming would
   * silently edit the first site when they asked to add a second.
   */
  const another = (await searchParams)['another'] === '1';

  // Already finished, and not deliberately adding another? Nothing to set up.
  const unfinished = another ? undefined : businesses.find((business) => !isOnboarded(business));
  if (!another && businesses.length > 0 && !unfinished) redirect('/dashboard');

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

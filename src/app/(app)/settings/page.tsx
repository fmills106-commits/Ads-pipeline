import type { Metadata } from 'next';
import { Card, PageHeader, Provenance } from '@/components/ui/primitives';
import { requireCurrentUser } from '@/server/auth/current-user';
import { listWorkspacesForUser } from '@/server/tenancy/context';
import { getEnv } from '@/lib/env';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const user = await requireCurrentUser();
  const workspaces = await listWorkspacesForUser(user);
  const env = getEnv();

  return (
    <>
      <PageHeader
        title="Settings"
        description="Account, workspace membership, and the platform-wide safeguards that no automation level can override."
      />

      <div className="space-y-4">
        <Card>
          <h2 className="mb-3 text-sm font-semibold">Account</h2>
          <dl className="grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
            <dt className="text-ink-muted">Name</dt>
            <dd>{user.name}</dd>
            <dt className="text-ink-muted">Email</dt>
            <dd>{user.email}</dd>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-3 text-sm font-semibold">Workspaces</h2>
          <ul className="space-y-2 text-sm">
            {workspaces.map(({ workspace, role }) => (
              <li key={workspace.id} className="flex items-center justify-between gap-4">
                <span>{workspace.name}</span>
                <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                  {role}
                </span>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <div className="mb-3 flex items-center gap-2">
            <h2 className="text-sm font-semibold">Spending safeguards</h2>
            <Provenance kind="verified" />
          </div>
          <p className="mb-3 text-sm text-ink-muted">
            Platform-wide ceilings, set by environment configuration. A business can be configured
            to spend less than these, never more, and the AI cannot raise them.
          </p>
          <dl className="grid gap-2 text-sm sm:grid-cols-[16rem_1fr]">
            <dt className="text-ink-muted">Max daily budget</dt>
            <dd className="tabular-nums">{formatCents(env.MAX_DAILY_BUDGET_CENTS)}</dd>
            <dt className="text-ink-muted">Max campaign budget</dt>
            <dd className="tabular-nums">{formatCents(env.MAX_CAMPAIGN_BUDGET_CENTS)}</dd>
            <dt className="text-ink-muted">Approval required above</dt>
            <dd className="tabular-nums">
              {formatCents(env.BUDGET_APPROVAL_THRESHOLD_CENTS)} / day
            </dd>
            <dt className="text-ink-muted">Mock mode</dt>
            <dd>
              {env.MOCK_MODE ? (
                <span className="font-medium text-status-ok">
                  On — no external calls, no real ad spend
                </span>
              ) : (
                <span className="font-medium text-status-pending">
                  Off — live providers are in use
                </span>
              )}
            </dd>
          </dl>
        </Card>
      </div>
    </>
  );
}

function formatCents(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

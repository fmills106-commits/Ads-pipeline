import Link from 'next/link';
import type { Metadata } from 'next';
import { Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { requireCurrentUser } from '@/server/auth/current-user';
import { listWorkspacesForUser } from '@/server/tenancy/context';
import { listBusinesses } from '@/server/business/service';
import { requireWorkspaceContext } from '@/server/tenancy/context';

export const metadata: Metadata = { title: 'Dashboard' };

export default async function DashboardPage() {
  const user = await requireCurrentUser();
  const workspaces = await listWorkspacesForUser(user);
  const active = workspaces[0];

  const businesses = active
    ? await listBusinesses(await requireWorkspaceContext(user, active.workspace.id))
    : [];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Spend, results and pending approvals across every business in this workspace."
      />

      {businesses.length === 0 ? (
        <EmptyState
          title="No businesses yet"
          description="Add a business and point it at a website. The scanner builds the product knowledge base that everything else is generated from."
          action={
            <Link
              href="/businesses"
              className="inline-flex rounded-md bg-accent px-4 py-2 text-sm font-medium text-white"
            >
              Add a business
            </Link>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Metric label="Businesses" value={String(businesses.length)} />
          <Metric label="Active campaigns" value="—" note="Phase 5" />
          <Metric label="Spend (30d)" value="—" note="Phase 7" />
          <Metric label="Pending approvals" value="—" note="Phase 4" />
        </div>
      )}

      <Card className="mt-6">
        <h2 className="text-sm font-semibold">Where the build is</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Phase 1 is complete: accounts, workspaces, businesses, tenant isolation, auditing and the
          job queue schema. Website scanning and product extraction land in Phase 2, at which point
          this dashboard starts showing real numbers instead of placeholders.
        </p>
      </Card>
    </>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      {note ? <p className="mt-1 text-xs text-ink-muted">Arrives in {note}</p> : null}
    </Card>
  );
}

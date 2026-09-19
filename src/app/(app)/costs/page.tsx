import type { Metadata } from 'next';
import { Card, PageHeader } from '@/components/ui/primitives';
import { requireCurrentUser } from '@/server/auth/current-user';
import { listWorkspacesForUser, requireWorkspaceContext } from '@/server/tenancy/context';
import { costSummary } from '@/server/cost/ledger';
import { prisma } from '@/lib/db';
import { formatCents } from '@/lib/budget';
import { isZeroCostMode } from '@/lib/env';

export const metadata: Metadata = { title: 'Costs' };

/**
 * What this application costs to run.
 *
 * Its own page because "never hide costs from the user" deserves more than a
 * line in Settings. In the normal case it says $0.00 and explains why, which
 * is the most useful thing it can say.
 *
 * Advertising spend is a separate concept and lives under Results.
 */
export default async function CostsPage() {
  const user = await requireCurrentUser();
  const workspaces = await listWorkspacesForUser(user);
  const active = workspaces[0];

  if (!active) {
    return <PageHeader title="Costs" description="Your account has no workspace." />;
  }

  // Resolved for the membership check; the queries below are workspace-scoped.
  await requireWorkspaceContext(user, active.workspace.id);

  const costs = await costSummary(active.workspace.id);

  const byProvider = await prisma.costRecord.groupBy({
    by: ['providerKey', 'tier'],
    where: { workspaceId: active.workspace.id },
    _count: { _all: true },
    _sum: { estimatedCostCents: true, actualCostCents: true, units: true },
    orderBy: { providerKey: 'asc' },
  });

  return (
    <>
      <PageHeader
        title="Costs"
        description="What running this application costs. Your advertising budget is separate."
      />

      {costs.isFree ? (
        <Card className="mb-5 border-status-ok/30 bg-status-ok/5">
          <div className="flex items-start gap-3">
            <span aria-hidden="true" className="text-xl">
              ✅
            </span>
            <div>
              <p className="font-medium">This has cost you nothing.</p>
              <p className="mt-1 text-sm text-ink-muted">
                {costs.freeCallCount.toLocaleString('en-US')} operations have run
                {isZeroCostMode()
                  ? ' entirely on this machine. No external service has been contacted, so there is nothing to bill.'
                  : ' without reaching a paid service.'}
              </p>
            </div>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <Figure label="Today" value={formatCents(costs.todayCents)} />
        <Figure label="This month" value={formatCents(costs.monthCents)} />
        <Figure label="All time" value={formatCents(costs.allTimeCents)} />
      </div>

      <Card className="mt-6">
        <h2 className="mb-1 text-sm font-semibold">Limits in force</h2>
        <p className="mb-4 text-sm text-ink-muted">
          A request that would take spending past one of these is refused before it is sent. Where a
          free alternative exists, the work runs on that instead and carries on.
        </p>
        <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-ink-muted">Per day</dt>
          <dd className="tabular-nums">{formatCents(costs.ceilings.dailyCents)}</dd>
          <dt className="text-ink-muted">Per month</dt>
          <dd className="tabular-nums">{formatCents(costs.ceilings.monthlyCents)}</dd>
          <dt className="text-ink-muted">Per single request</dt>
          <dd className="tabular-nums">{formatCents(costs.ceilings.singleCallCents)}</dd>
        </dl>
      </Card>

      <Card className="mt-4">
        <h2 className="mb-4 text-sm font-semibold">By service</h2>
        {byProvider.length === 0 ? (
          <p className="text-sm text-ink-muted">Nothing has run yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs uppercase tracking-wide text-ink-muted">
                <th className="pb-2 font-medium">Service</th>
                <th className="pb-2 font-medium">Type</th>
                <th className="pb-2 text-right font-medium">Operations</th>
                <th className="pb-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {byProvider.map((row) => {
                const cents = row._sum.actualCostCents ?? row._sum.estimatedCostCents ?? 0;
                return (
                  <tr
                    key={`${row.providerKey}-${row.tier}`}
                    className="border-b border-border-subtle last:border-0"
                  >
                    <td className="py-2 font-medium">{row.providerKey}</td>
                    <td className="py-2">
                      <span
                        className={
                          row.tier === 'LOCAL_FREE' ? 'text-status-ok' : 'text-status-pending'
                        }
                      >
                        {row.tier === 'LOCAL_FREE' ? 'Local / free' : 'External / paid'}
                      </span>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {row._count._all.toLocaleString('en-US')}
                    </td>
                    <td className="py-2 text-right tabular-nums">{formatCents(cents)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}

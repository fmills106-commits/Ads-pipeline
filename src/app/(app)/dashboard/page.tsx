import Link from 'next/link';
import type { Metadata } from 'next';
import { Card, EmptyState } from '@/components/ui/primitives';
import { requireCurrentUser } from '@/server/auth/current-user';
import {
  listWorkspacesForUser,
  requireBusinessContext,
  requireWorkspaceContext,
} from '@/server/tenancy/context';
import { listBusinesses } from '@/server/business/service';
import { isOnboarded, GOAL_CHOICES, AUTOMATION_CHOICES } from '@/server/business/onboarding';
import { pendingAttentionCount, recentActivity } from '@/server/activity/feed';
import { costSummary } from '@/server/cost/ledger';
import { formatBudget, formatCents } from '@/lib/budget';
import { isZeroCostMode } from '@/lib/env';
import { PauseControl } from './pause-control';
import { ActivityFeed } from './activity-feed';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * The dashboard a business owner actually reads.
 *
 * Six facts and a feed. Everything technical — provider routing, experiment
 * parameters, QA thresholds, job queues — is happening, and none of it is
 * here. What is here is what someone paying for advertising wants to know:
 * is it running, what has it spent, what did it get me, and does it need me.
 */
export default async function DashboardPage() {
  const user = await requireCurrentUser();
  const workspaces = await listWorkspacesForUser(user);
  const active = workspaces[0];

  if (!active) {
    return (
      <EmptyState
        title="No workspace"
        description="Your account is not a member of any workspace."
      />
    );
  }

  const workspaceContext = await requireWorkspaceContext(user, active.workspace.id);
  const businesses = await listBusinesses(workspaceContext);
  const business = businesses[0];

  if (!business) {
    return (
      <EmptyState
        title="Let's get started"
        description="Add your business and website. We'll read the site, learn what you sell, and put together your advertising."
        action={
          <Link
            href="/setup"
            className="inline-flex rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white"
          >
            Set up my advertising
          </Link>
        }
      />
    );
  }

  if (!isOnboarded(business)) {
    return (
      <EmptyState
        title="Almost there"
        description="A couple more questions and your advertising is ready to go."
        action={
          <Link
            href="/setup"
            className="inline-flex rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white"
          >
            Finish setup
          </Link>
        }
      />
    );
  }

  const businessContext = await requireBusinessContext(user, business.id);
  const [activity, attention, costs] = await Promise.all([
    recentActivity(businessContext, 12),
    pendingAttentionCount(businessContext),
    costSummary(active.workspace.id),
  ]);

  const paused = business.pausedAt !== null;
  const goalLabel = GOAL_CHOICES.find((choice) => choice.value === business.goal)?.label ?? '—';
  const automationLabel =
    AUTOMATION_CHOICES.find((choice) => choice.value === business.automationMode)?.label ?? '—';

  // Phase 7 fills these from real performance snapshots. Until then they are
  // shown as "not yet" rather than as zeros, because a confident "$0.00 spent"
  // and "we have not started spending" are different statements.
  const hasPerformanceData = false;

  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{business.name}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {goalLabel} ·{' '}
            {business.budgetAmountCents !== null && business.budgetPeriod !== null
              ? formatBudget(business.budgetAmountCents, business.budgetPeriod, business.currency)
              : '—'}{' '}
            · {automationLabel}
          </p>
        </div>
        <PauseControl businessId={business.id} paused={paused} />
      </header>

      {isZeroCostMode() ? (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-muted p-4">
          <span aria-hidden="true">🧪</span>
          <p className="text-sm text-ink-muted">
            <strong className="text-ink">Simulation mode.</strong> Everything works end to end, but
            no ads are being served and no money is being spent — by you or by this application.
            Costs so far: <strong className="text-ink">{formatCents(costs.allTimeCents)}</strong>.
          </p>
        </div>
      ) : null}

      {paused ? (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-status-danger/30 bg-status-danger/5 p-4">
          <span aria-hidden="true">🛑</span>
          <p className="text-sm">
            <strong>Everything is paused.</strong>{' '}
            <span className="text-ink-muted">
              {business.pauseReason ?? 'Nothing will run or spend until you resume.'}
            </span>
          </p>
        </div>
      ) : null}

      {attention > 0 ? (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-status-pending/40 bg-status-pending/5 p-4">
          <span aria-hidden="true">❓</span>
          <p className="text-sm">
            <strong>
              {attention} {attention === 1 ? 'thing needs' : 'things need'} your input.
            </strong>{' '}
            <span className="text-ink-muted">See the activity below.</span>
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Advertising"
          value={paused ? 'Paused' : 'Getting ready'}
          tone={paused ? 'danger' : 'ok'}
          note={paused ? 'You paused it' : 'Website scanning arrives next'}
        />
        <Stat label="Spend" value={hasPerformanceData ? '—' : 'Not yet'} note="Nothing spent" />
        <Stat label="Sales" value={hasPerformanceData ? '—' : 'Not yet'} />
        <Stat label="Current ads" value="0" note="None created yet" />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <h2 className="mb-4 text-sm font-semibold">Recent activity</h2>
          <ActivityFeed items={activity} />
        </Card>

        <Card className="h-fit">
          <h2 className="mb-1 text-sm font-semibold">What happens next</h2>
          <p className="text-sm text-ink-muted">
            Website scanning and product discovery are the next thing being built. Once they land,
            this page starts filling in on its own — you won&rsquo;t need to do anything.
          </p>
          <dl className="mt-4 space-y-2 border-t border-border-subtle pt-4 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">Website</dt>
              <dd className="truncate">{business.websiteUrl ?? 'Not set'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-muted">Daily limit</dt>
              <dd className="tabular-nums">
                {formatCents(business.maxDailyBudgetCents, business.currency)}
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}

function Stat({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'ok' | 'danger';
}) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <p
        className={
          tone === 'ok'
            ? 'mt-2 text-xl font-semibold text-status-ok'
            : tone === 'danger'
              ? 'mt-2 text-xl font-semibold text-status-danger'
              : 'mt-2 text-xl font-semibold tabular-nums'
        }
      >
        {tone === 'ok' ? '🟢 ' : tone === 'danger' ? '🔴 ' : ''}
        {value}
      </p>
      {note ? <p className="mt-1 text-xs text-ink-muted">{note}</p> : null}
    </Card>
  );
}

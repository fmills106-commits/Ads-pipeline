'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/primitives';
import { formatCents } from '@/lib/budget';

/**
 * Advanced settings.
 *
 * Collapsed, and a normal user never needs to open it. What is inside is
 * mostly *not* configurable here on purpose — it is a read-out of the
 * safeguards the system derived and is operating under.
 *
 * Showing them matters even though they are not editable: "the complexity
 * belongs in the software, not the user's setup" is not the same as hiding
 * what the software decided. Someone who wants to check that a $10/day budget
 * really did produce a $10/day ceiling can see it in one click.
 */
export function AdvancedSettings({
  userName,
  userEmail,
  workspaceName,
  workspaceRole,
  zeroCostMode,
  ceilings,
  business,
}: {
  userName: string;
  userEmail: string;
  workspaceName: string;
  workspaceRole: string;
  zeroCostMode: boolean;
  ceilings: { dailyCents: number; monthlyCents: number; singleCallCents: number };
  business: {
    maxDailyBudgetCents: number;
    maxCampaignBudgetCents: number;
    budgetApprovalThresholdCents: number;
    currency: string;
  } | null;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Card>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 text-left"
      >
        <span>
          <span className="text-sm font-semibold">Advanced</span>
          <span className="ml-2 text-sm text-ink-muted">
            Account, and the limits the system set for you
          </span>
        </span>
        <span aria-hidden="true" className="text-ink-muted">
          {open ? '▾' : '▸'}
        </span>
      </button>

      {open ? (
        <div className="mt-5 space-y-5 border-t border-border-subtle pt-5">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Account
            </h3>
            <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
              <dt className="text-ink-muted">Name</dt>
              <dd>{userName}</dd>
              <dt className="text-ink-muted">Email</dt>
              <dd>{userEmail}</dd>
              <dt className="text-ink-muted">Workspace</dt>
              <dd>
                {workspaceName} ({workspaceRole.toLowerCase()})
              </dd>
            </dl>
          </section>

          {business ? (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Advertising limits
              </h3>
              <p className="mb-3 text-sm text-ink-muted">
                Worked out from the budget you gave. These are hard ceilings — automation cannot
                raise them, and neither can the AI.
              </p>
              <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
                <dt className="text-ink-muted">Most per day</dt>
                <dd className="tabular-nums">
                  {formatCents(business.maxDailyBudgetCents, business.currency)}
                </dd>
                <dt className="text-ink-muted">Most per campaign</dt>
                <dd className="tabular-nums">
                  {formatCents(business.maxCampaignBudgetCents, business.currency)}
                </dd>
                <dt className="text-ink-muted">Asks you above</dt>
                <dd className="tabular-nums">
                  {formatCents(business.budgetApprovalThresholdCents, business.currency)} per day
                </dd>
              </dl>
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Infrastructure spending
            </h3>
            <p className="mb-3 text-sm text-ink-muted">
              What the application itself may spend on AI and other metered services. Separate from
              your advertising budget.
            </p>
            <dl className="grid gap-2 text-sm sm:grid-cols-[12rem_1fr]">
              <dt className="text-ink-muted">Mode</dt>
              <dd>
                {zeroCostMode ? (
                  <span className="font-medium text-status-ok">
                    Zero-cost — paid services unreachable
                  </span>
                ) : (
                  <span className="font-medium text-status-pending">
                    Paid services permitted where enabled
                  </span>
                )}
              </dd>
              <dt className="text-ink-muted">Limit per day</dt>
              <dd className="tabular-nums">{formatCents(ceilings.dailyCents)}</dd>
              <dt className="text-ink-muted">Limit per month</dt>
              <dd className="tabular-nums">{formatCents(ceilings.monthlyCents)}</dd>
              <dt className="text-ink-muted">Limit per request</dt>
              <dd className="tabular-nums">{formatCents(ceilings.singleCallCents)}</dd>
            </dl>
            <p className="mt-3 text-xs text-ink-muted">
              These come from the deployment&rsquo;s environment configuration. Changing them is a
              server-side decision, not an in-app setting, so nothing in this interface can start a
              bill.
            </p>
          </section>
        </div>
      ) : null}
    </Card>
  );
}

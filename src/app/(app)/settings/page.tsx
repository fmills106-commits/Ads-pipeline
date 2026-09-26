import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import Link from 'next/link';
import type { ProviderCapability } from '@prisma/client';
import { Card, PageHeader, cx } from '@/components/ui/primitives';
import { requireCurrentUser } from '@/server/auth/current-user';
import { summariseCapability } from '@/server/providers';
import { loadPaidProviderState } from '@/server/providers/run';
import { listProviderSettings, paidSpendPossible, whyBlocked } from '@/server/providers/settings';
import { acceptsOwnerKey } from '@/server/providers/credentials';
import { costSummary } from '@/server/cost/ledger';
import { AUTOMATION_CHOICES, GOAL_CHOICES } from '@/server/business/onboarding';
import { formatBudget, formatCents } from '@/lib/budget';
import { isZeroCostMode } from '@/lib/env';
import { parseTheme, THEME_COOKIE } from '@/lib/theme';
import { AdvancedSettings } from './advanced-settings';
import { BusinessName } from './business-name';
import { PaidProvider } from './paid-provider';
import { ThemeSwitch } from './theme-switch';
import { resolveActiveBusiness } from '@/server/tenancy/active-business';

export const metadata: Metadata = { title: 'Settings' };

const CAPABILITY_LABEL: Record<ProviderCapability, string> = {
  AI: 'Writing ads and strategy',
  IMAGE_GENERATION: 'Creating ad images',
  ADVERTISING: 'Running the ads',
  STORAGE: 'Storing your files',
  ANALYTICS: 'Measuring results',
  SEARCH: 'Search',
  EMBEDDING: 'Similarity matching',
  WEB_FETCH: 'Reading your website',
};

/** Only the capabilities that are actually wired up are shown. */
const VISIBLE_CAPABILITIES: ProviderCapability[] = [
  'WEB_FETCH',
  'AI',
  'IMAGE_GENERATION',
  'ADVERTISING',
  'STORAGE',
];

export default async function SettingsPage() {
  const user = await requireCurrentUser();
  const { workspaceContext: context, business } = await resolveActiveBusiness(user);

  if (!context) {
    return <PageHeader title="Settings" description="Your account has no workspace." />;
  }

  const [{ enabledPaid, secrets }, costs, providerSettings] = await Promise.all([
    loadPaidProviderState(context.workspace.id),
    costSummary(context.workspace.id),
    listProviderSettings(context),
  ]);

  const settingsByKey = new Map(providerSettings.map((row) => [row.providerKey, row]));
  // Every reading below is from this workspace's point of view, credentials
  // included: an owner with their own key stored must not be told that none is
  // configured just because the deployment itself has none.
  const paidPossible = paidSpendPossible(secrets);
  const capabilities = VISIBLE_CAPABILITIES.map((capability) =>
    summariseCapability(capability, { enabledPaid, secrets }),
  );

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your advertising setup, and what this application is using behind the scenes."
      />

      <div className="space-y-4">
        {business ? (
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Your advertising</h2>
            <dl className="grid gap-3 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-ink-muted">Business</dt>
              <dd>
                <BusinessName businessId={business.id} name={business.name} />
              </dd>
              <dt className="text-ink-muted">Website</dt>
              {/* The address is changed on the Website page, next to what was
                  read from it — so this says where, rather than being a dead
                  end for someone who came here looking to edit it. */}
              <dd className="flex flex-wrap items-baseline gap-x-2">
                <span>{business.websiteUrl ?? 'Not set'}</span>
                <Link
                  href="/website"
                  className="text-xs text-accent underline-offset-2 hover:underline"
                >
                  {business.websiteUrl ? 'Change' : 'Add one'}
                </Link>
              </dd>
              <dt className="text-ink-muted">Goal</dt>
              <dd>{GOAL_CHOICES.find((c) => c.value === business.goal)?.label ?? 'Not set'}</dd>
              <dt className="text-ink-muted">Budget</dt>
              <dd>
                {business.budgetAmountCents !== null && business.budgetPeriod !== null
                  ? formatBudget(
                      business.budgetAmountCents,
                      business.budgetPeriod,
                      business.currency,
                    )
                  : 'Not set'}
              </dd>
              <dt className="text-ink-muted">Automation</dt>
              <dd>
                {AUTOMATION_CHOICES.find((c) => c.value === business.automationMode)?.label ?? '—'}
              </dd>
            </dl>
          </Card>
        ) : null}

        <Card>
          <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">What this is costing you</h2>
            {costs.isFree ? (
              <span className="rounded-full bg-status-ok/10 px-2.5 py-0.5 text-xs font-medium text-status-ok">
                Free
              </span>
            ) : null}
          </div>
          <p className="mb-4 text-sm text-ink-muted">
            This is what the application spends on its own AI and infrastructure — separate from
            your advertising budget.
          </p>
          <dl className="grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-ink-muted">Today</dt>
            <dd className="tabular-nums">{formatCents(costs.todayCents)}</dd>
            <dt className="text-ink-muted">This month</dt>
            <dd className="tabular-nums">{formatCents(costs.monthCents)}</dd>
            <dt className="text-ink-muted">All time</dt>
            <dd className="tabular-nums">{formatCents(costs.allTimeCents)}</dd>
            <dt className="text-ink-muted">Free operations</dt>
            <dd className="tabular-nums">{costs.freeCallCount.toLocaleString('en-US')}</dd>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-1 text-sm font-semibold">What&rsquo;s doing the work</h2>
          <p className="mb-4 text-sm text-ink-muted">
            {isZeroCostMode()
              ? 'Everything is running locally on this machine. Nothing here can charge you.'
              : 'Paid services are only used where you have switched them on.'}
          </p>

          <ul className="space-y-3">
            {capabilities.map((capability) => (
              <li
                key={capability.capability}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle pb-3 last:border-0 last:pb-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{CAPABILITY_LABEL[capability.capability]}</p>
                  <p className="text-sm text-ink-muted">{capability.activeLabel}</p>
                </div>
                <TierBadge tier={capability.tier} />
              </li>
            ))}
          </ul>

          {capabilities.some((c) => c.paidAlternatives.length > 0) ? (
            <div className="mt-5 border-t border-border-subtle pt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Optional paid upgrades
              </h3>
              <p className="mb-3 text-sm text-ink-muted">
                {paidPossible
                  ? 'Off unless you switch one on. Each has its own daily limit, and the lower of that and this deployment’s limit applies.'
                  : 'All off, and none of them can be switched on in this deployment’s current configuration. Each says what would have to change.'}
              </p>
              <ul className="space-y-4 text-sm">
                {capabilities.flatMap((capability) =>
                  capability.paidAlternatives.map((alternative) => (
                    <PaidProvider
                      key={alternative.key}
                      workspaceId={context.workspace.id}
                      providerKey={alternative.key}
                      label={alternative.label}
                      description={alternative.description}
                      enabled={alternative.enabled}
                      blockedMessage={whyBlocked(alternative.key, secrets)?.message ?? null}
                      blockedReason={whyBlocked(alternative.key, secrets)?.reason ?? null}
                      maxDailyCostCents={
                        settingsByKey.get(alternative.key)?.maxDailyCostCents ?? null
                      }
                      acceptsOwnKey={acceptsOwnerKey(alternative.key)}
                      ownKeyHint={settingsByKey.get(alternative.key)?.secretHint ?? null}
                      keyFromEnvironment={
                        secrets.sources.anthropic === 'environment' &&
                        alternative.key === 'ai.anthropic'
                      }
                    />
                  )),
                )}
              </ul>
            </div>
          ) : null}
        </Card>

        <Card>
          <h2 className="mb-1 text-sm font-semibold">Appearance</h2>
          <p className="mb-4 text-sm text-ink-muted">
            Light or dark. &ldquo;Auto&rdquo; follows whatever your phone or computer is set to,
            which is what it does unless you say otherwise.
          </p>
          <div className="max-w-xs">
            <ThemeSwitch theme={parseTheme((await cookies()).get(THEME_COOKIE)?.value)} />
          </div>
        </Card>

        <AdvancedSettings
          userName={user.name}
          userEmail={user.email}
          workspaceName={context.workspace.name}
          workspaceRole={context.role}
          zeroCostMode={isZeroCostMode()}
          ceilings={costs.ceilings}
          business={
            business
              ? {
                  maxDailyBudgetCents: business.maxDailyBudgetCents,
                  maxCampaignBudgetCents: business.maxCampaignBudgetCents,
                  budgetApprovalThresholdCents: business.budgetApprovalThresholdCents,
                  currency: business.currency,
                }
              : null
          }
        />
      </div>
    </>
  );
}

function TierBadge({ tier }: { tier: 'LOCAL_FREE' | 'EXTERNAL_PAID' }) {
  const free = tier === 'LOCAL_FREE';
  return (
    <span
      className={cx(
        'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
        free ? 'bg-status-ok/10 text-status-ok' : 'bg-status-pending/10 text-status-pending',
      )}
    >
      {free ? 'Local / free' : 'External / paid'}
    </span>
  );
}

import type { Metadata } from 'next';
import { Card, EmptyState, PageHeader } from '@/components/ui/primitives';
import { requireCurrentUser } from '@/server/auth/current-user';
import { listBusinesses } from '@/server/business/service';
import { listWorkspacesForUser, requireWorkspaceContext } from '@/server/tenancy/context';
import { AddBusinessForm } from './add-business-form';

export const metadata: Metadata = { title: 'Businesses' };

const AUTOMATION_LABEL: Record<string, string> = {
  MANUAL: 'Level 1 · everything requires approval',
  ASSISTED: 'Level 2 · creative auto, publishing approved',
  SUPERVISED: 'Level 3 · campaigns auto within limits',
  AUTONOMOUS: 'Level 4 · fully automated within rules',
};

export default async function BusinessesPage() {
  const user = await requireCurrentUser();
  const workspaces = await listWorkspacesForUser(user);
  const active = workspaces[0];

  if (!active) {
    return (
      <EmptyState
        title="No workspace"
        description="Your account is not a member of any workspace. Sign out and register again, or ask an owner to invite you."
      />
    );
  }

  const context = await requireWorkspaceContext(user, active.workspace.id);
  const businesses = await listBusinesses(context);

  return (
    <>
      <PageHeader
        title="Businesses"
        description="Each business is a separate tenant. Knowledge, creatives, campaigns and everything learned from performance stay inside it."
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-3">
          {businesses.length === 0 ? (
            <EmptyState
              title="No businesses yet"
              description="Add your first business using the form. Onboarding is the same for every business — nothing about any particular industry is built into the platform."
            />
          ) : (
            businesses.map((business) => (
              <Card key={business.id} className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="font-medium">{business.name}</p>
                  <p className="mt-0.5 text-sm text-ink-muted">
                    {business.industry ?? 'Industry not set'}
                  </p>
                  {business.websiteUrl ? (
                    <p className="mt-1 truncate text-sm text-accent" title={business.websiteUrl}>
                      {business.websiteUrl}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-ink-muted">No website yet</p>
                  )}
                  <p className="mt-2 text-xs text-ink-muted">
                    {AUTOMATION_LABEL[business.automationLevel] ?? business.automationLevel}
                  </p>
                </div>
                <div className="shrink-0 text-right text-xs text-ink-muted">
                  <p>Daily cap</p>
                  <p className="font-medium tabular-nums text-ink">
                    {formatMoney(business.maxDailyBudgetCents, business.currency)}
                  </p>
                </div>
              </Card>
            ))
          )}
        </div>

        <Card className="h-fit">
          <h2 className="mb-1 text-sm font-semibold">Add a business</h2>
          <p className="mb-4 text-sm text-ink-muted">
            Starts at automation Level 1 with the platform&rsquo;s default spending caps.
          </p>
          <AddBusinessForm workspaceId={active.workspace.id} />
        </Card>
      </div>
    </>
  );
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
  }).format(cents / 100);
}

'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Field, Input, cx } from '@/components/ui/primitives';
import { formatCents, parseBudgetToCents, DAYS_PER_MONTH_FOR_BUDGETING } from '@/lib/budget';

/**
 * The four-step setup.
 *
 * Each step asks one question in the owner's own vocabulary. There is no
 * "advanced" path to get lost in, no terminology to look up, and nothing
 * optional — if it is on this screen, it is because the system genuinely
 * cannot work it out on its own.
 */

type Goal = 'SALES' | 'LEADS' | 'CUSTOMERS' | 'AWARENESS';
type Period = 'DAILY' | 'MONTHLY';
type Automation = 'AUTOPILOT' | 'ASK_ME_FIRST' | 'MANUAL';

const GOALS: Array<{ value: Goal; label: string; help: string; icon: string }> = [
  { value: 'SALES', label: 'Get more sales', help: 'People buy on your website.', icon: '🛒' },
  { value: 'LEADS', label: 'Get more leads', help: 'People enquire, then buy.', icon: '✉️' },
  { value: 'CUSTOMERS', label: 'Get more customers', help: 'Reach new people.', icon: '👥' },
  { value: 'AWARENESS', label: 'Grow awareness', help: 'More people know you exist.', icon: '📣' },
];

const AUTOMATION: Array<{
  value: Automation;
  label: string;
  help: string;
  icon: string;
  recommended?: boolean;
}> = [
  {
    value: 'AUTOPILOT',
    label: 'Autopilot',
    help: 'The AI runs your advertising within your budget. It still asks you whenever something important is uncertain.',
    icon: '🤖',
  },
  {
    value: 'ASK_ME_FIRST',
    label: 'Ask me first',
    help: 'The AI prepares everything and checks with you before anything goes live.',
    icon: '✋',
    recommended: true,
  },
  {
    value: 'MANUAL',
    label: 'Manual',
    help: 'The AI suggests ads and creatives. You approve every action yourself.',
    icon: '🎛️',
  },
];

const BUDGET_PRESETS: Array<{ amount: string; period: Period }> = [
  { amount: '5', period: 'DAILY' },
  { amount: '10', period: 'DAILY' },
  { amount: '20', period: 'DAILY' },
  { amount: '300', period: 'MONTHLY' },
];

export function SetupWizard({
  workspaceId,
  existingBusiness,
  maxDailyBudgetCents,
}: {
  workspaceId: string;
  existingBusiness: { id: string; name: string; websiteUrl: string | null } | null;
  maxDailyBudgetCents: number;
}) {
  const router = useRouter();

  const [step, setStep] = useState(existingBusiness ? 2 : 1);
  const [businessId, setBusinessId] = useState<string | null>(existingBusiness?.id ?? null);
  const [name, setName] = useState(existingBusiness?.name ?? '');
  const [websiteUrl, setWebsiteUrl] = useState(existingBusiness?.websiteUrl ?? '');
  const [goal, setGoal] = useState<Goal | null>(null);
  const [budgetText, setBudgetText] = useState('10');
  const [period, setPeriod] = useState<Period>('DAILY');
  const [automation, setAutomation] = useState<Automation>('ASK_ME_FIRST');

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const budgetCents = parseBudgetToCents(budgetText);
  const dailyCents =
    budgetCents === null
      ? null
      : period === 'DAILY'
        ? budgetCents
        : Math.floor(budgetCents / DAYS_PER_MONTH_FOR_BUDGETING);
  const overCap = dailyCents !== null && dailyCents > maxDailyBudgetCents;

  async function createBusiness() {
    setError(null);
    if (name.trim().length === 0) return setError('Please enter your business name.');
    setBusy(true);
    try {
      const response = await fetch('/api/businesses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          name: name.trim(),
          ...(websiteUrl.trim() ? { websiteUrl: websiteUrl.trim() } : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        data?: { id: string };
        error?: { message?: string };
      } | null;

      if (!response.ok || !payload?.data) {
        setError(payload?.error?.message ?? 'Could not save your business.');
        return;
      }
      setBusinessId(payload.data.id);
      setStep(2);
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setError(null);
    if (!businessId || !goal || budgetCents === null) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/businesses/${businessId}/onboarding`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal,
          budgetAmountCents: budgetCents,
          budgetPeriod: period,
          automationMode: automation,
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? 'Could not finish setup.');
        return;
      }
      router.refresh();
      router.push('/dashboard');
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Steps current={step} />

      {step === 1 ? (
        <Card>
          <StepHeading
            title="What's your business?"
            subtitle="Add your website and we'll read it to learn what you sell. You don't need to describe anything."
          />
          <div className="space-y-4">
            <Field label="Business name">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Alpine Coffee Roasters"
                maxLength={200}
                autoFocus
              />
            </Field>
            <Field label="Website" hint="Optional, but it's how the AI learns about your products.">
              <Input
                value={websiteUrl}
                onChange={(event) => setWebsiteUrl(event.target.value)}
                placeholder="https://yourshop.com"
                type="url"
                maxLength={2048}
              />
            </Field>
          </div>
          <Footer
            error={error}
            primary={
              <Button onClick={createBusiness} disabled={busy || name.trim().length === 0}>
                {busy ? 'Saving…' : 'Continue'}
              </Button>
            }
          />
        </Card>
      ) : null}

      {step === 2 ? (
        <Card>
          <StepHeading title="What do you want more of?" subtitle="Pick the closest one." />
          <div className="grid gap-3 sm:grid-cols-2">
            {GOALS.map((choice) => (
              <ChoiceCard
                key={choice.value}
                icon={choice.icon}
                label={choice.label}
                help={choice.help}
                selected={goal === choice.value}
                onSelect={() => setGoal(choice.value)}
              />
            ))}
          </div>
          <Footer
            error={error}
            secondary={
              <Button variant="secondary" onClick={() => setStep(1)}>
                Back
              </Button>
            }
            primary={
              <Button onClick={() => setStep(3)} disabled={!goal}>
                Continue
              </Button>
            }
          />
        </Card>
      ) : null}

      {step === 3 ? (
        <Card>
          <StepHeading
            title="What can you spend on ads?"
            subtitle="You can change this any time. The system will never spend more than this."
          />

          <div className="mb-4 flex flex-wrap gap-2">
            {BUDGET_PRESETS.map((preset) => {
              const active = budgetText === preset.amount && period === preset.period;
              return (
                <button
                  key={`${preset.amount}-${preset.period}`}
                  type="button"
                  onClick={() => {
                    setBudgetText(preset.amount);
                    setPeriod(preset.period);
                  }}
                  className={cx(
                    'rounded-full border px-4 py-1.5 text-sm transition',
                    active
                      ? 'border-accent bg-accent-soft font-medium text-accent'
                      : 'border-border-subtle hover:bg-surface-muted',
                  )}
                >
                  ${preset.amount}/{preset.period === 'DAILY' ? 'day' : 'month'}
                </button>
              );
            })}
          </div>

          <div className="flex items-end gap-3">
            <div className="flex-1">
              <Field label="Budget">
                <div className="flex items-center gap-2">
                  <span className="text-lg text-ink-muted">$</span>
                  <Input
                    value={budgetText}
                    onChange={(event) => setBudgetText(event.target.value)}
                    inputMode="decimal"
                    placeholder="10"
                  />
                </div>
              </Field>
            </div>
            <div className="pb-1">
              <div className="inline-flex overflow-hidden rounded-md border border-border-subtle">
                {(['DAILY', 'MONTHLY'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setPeriod(option)}
                    className={cx(
                      'px-4 py-2 text-sm transition',
                      period === option
                        ? 'bg-accent font-medium text-white'
                        : 'hover:bg-surface-muted',
                    )}
                  >
                    per {option === 'DAILY' ? 'day' : 'month'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {budgetCents === null && budgetText.trim() !== '' ? (
            <p className="mt-3 text-sm text-status-danger">Enter an amount like 10 or 12.50.</p>
          ) : null}

          {dailyCents !== null && !overCap ? (
            <p className="mt-3 text-sm text-ink-muted">
              That works out to about{' '}
              <strong className="text-ink">{formatCents(dailyCents)} a day</strong>. The system
              keeps its own spending below this — it can&rsquo;t go over.
            </p>
          ) : null}

          {overCap ? (
            <p className="mt-3 text-sm text-status-danger">
              This deployment is limited to {formatCents(maxDailyBudgetCents)} a day as a safety
              measure. Please choose a smaller budget, or ask whoever runs this installation to
              raise the limit.
            </p>
          ) : null}

          <Footer
            error={error}
            secondary={
              <Button variant="secondary" onClick={() => setStep(2)}>
                Back
              </Button>
            }
            primary={
              <Button onClick={() => setStep(4)} disabled={budgetCents === null || overCap}>
                Continue
              </Button>
            }
          />
        </Card>
      ) : null}

      {step === 4 ? (
        <Card>
          <StepHeading
            title="How involved do you want to be?"
            subtitle="You can change this whenever you like, and you can pause everything with one button at any time."
          />
          <div className="space-y-3">
            {AUTOMATION.map((choice) => (
              <ChoiceCard
                key={choice.value}
                icon={choice.icon}
                label={choice.label}
                help={choice.help}
                badge={choice.recommended ? 'Recommended' : undefined}
                selected={automation === choice.value}
                onSelect={() => setAutomation(choice.value)}
                wide
              />
            ))}
          </div>
          <Footer
            error={error}
            secondary={
              <Button variant="secondary" onClick={() => setStep(3)}>
                Back
              </Button>
            }
            primary={
              <Button onClick={finish} disabled={busy}>
                {busy ? 'Finishing…' : 'Finish setup'}
              </Button>
            }
          />
        </Card>
      ) : null}
    </div>
  );
}

function Steps({ current }: { current: number }) {
  const labels = ['Business', 'Goal', 'Budget', 'Automation'];
  return (
    <ol className="mb-6 flex items-center gap-2" aria-label="Setup progress">
      {labels.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              className={cx(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                done && 'bg-status-ok text-white',
                active && 'bg-accent text-white',
                !done && !active && 'border border-border-subtle text-ink-muted',
              )}
              aria-current={active ? 'step' : undefined}
            >
              {done ? '✓' : step}
            </span>
            <span
              className={cx(
                'hidden text-sm sm:inline',
                active ? 'font-medium text-ink' : 'text-ink-muted',
              )}
            >
              {label}
            </span>
            {step < labels.length ? (
              <span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>
    </div>
  );
}

function ChoiceCard({
  icon,
  label,
  help,
  badge,
  selected,
  onSelect,
  wide,
}: {
  icon: string;
  label: string;
  help: string;
  badge?: string;
  selected: boolean;
  onSelect: () => void;
  wide?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        'rounded-lg border p-4 text-left transition',
        wide ? 'flex w-full items-start gap-3' : 'block',
        selected
          ? 'border-accent bg-accent-soft ring-1 ring-accent'
          : 'border-border-subtle hover:border-accent hover:bg-surface-muted',
      )}
    >
      <span className="text-xl" aria-hidden="true">
        {icon}
      </span>
      <span className={wide ? 'min-w-0' : 'mt-2 block'}>
        <span className="flex items-center gap-2">
          <span className="font-medium">{label}</span>
          {badge ? (
            <span className="rounded-full bg-status-ok/10 px-2 py-0.5 text-[11px] font-medium text-status-ok">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 block text-sm text-ink-muted">{help}</span>
      </span>
    </button>
  );
}

function Footer({
  error,
  primary,
  secondary,
}: {
  error: string | null;
  primary: React.ReactNode;
  secondary?: React.ReactNode;
}) {
  return (
    <>
      {error ? (
        <p className="mt-4 text-sm text-status-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-6 flex items-center justify-end gap-2">
        {secondary}
        {primary}
      </div>
    </>
  );
}

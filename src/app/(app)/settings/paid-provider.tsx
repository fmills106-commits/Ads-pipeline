'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Input, cx } from '@/components/ui/primitives';

/**
 * The switch for one paid service.
 *
 * This is the only control in the application that can cause a charge, so it
 * behaves differently from every other one here:
 *
 *  - It asks before switching **on**, and the confirmation states the ceiling
 *    in money. "Are you sure?" is not consent; "up to $2.00 a day" is.
 *  - It never asks before switching **off**. Withdrawing permission to spend
 *    must be one click, always.
 *  - When it cannot be switched on it says why, in the words of the thing that
 *    has to change, instead of showing a control that fails.
 *
 * The limit is entered in dollars and sent in cents. The server intersects it
 * with the platform ceiling and the lower always wins, so a number typed here
 * can only ever reduce what may be spent.
 */
export function PaidProvider({
  workspaceId,
  providerKey,
  label,
  description,
  enabled,
  blockedMessage,
  maxDailyCostCents,
}: {
  workspaceId: string;
  providerKey: string;
  label: string;
  description: string;
  enabled: boolean;
  /** Null when it could be switched on right now. */
  blockedMessage: string | null;
  maxDailyCostCents: number | null;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [dailyDollars, setDailyDollars] = useState(
    maxDailyCostCents === null ? '' : (maxDailyCostCents / 100).toFixed(2),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(next: boolean) {
    setBusy(true);
    setError(null);

    const trimmed = dailyDollars.trim();
    const parsed = trimmed === '' ? null : Math.round(Number(trimmed) * 100);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
      setError('Enter a daily limit like 2.00, or leave it empty.');
      setBusy(false);
      return;
    }

    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/providers`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          providerKey,
          enabled: next,
          maxDailyCostCents: parsed,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? 'Could not change that setting.');
        return;
      }

      setConfirming(false);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="border-b border-border-subtle pb-4 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-sm text-ink-muted">{description}</p>
        </div>

        <div className="shrink-0">
          {enabled ? (
            <Button variant="secondary" disabled={busy} onClick={() => void send(false)}>
              {busy ? 'Turning off…' : 'Turn off'}
            </Button>
          ) : blockedMessage ? (
            <span className="text-xs text-ink-muted">Cannot be turned on yet</span>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(true)}>
              Turn on
            </Button>
          )}
        </div>
      </div>

      <p
        className={cx(
          'mt-2 inline-block rounded-full px-2.5 py-0.5 text-xs font-medium',
          enabled ? 'bg-status-pending/10 text-status-pending' : 'bg-status-ok/10 text-status-ok',
        )}
      >
        {enabled
          ? maxDailyCostCents === null
            ? 'On — no limit of its own'
            : `On — up to ${formatDollars(maxDailyCostCents)} a day`
          : 'Off — cannot charge you'}
      </p>

      {blockedMessage && !enabled ? (
        <p className="mt-2 rounded-md border border-border-subtle bg-surface-muted p-3 text-sm text-ink-muted">
          {blockedMessage}
        </p>
      ) : null}

      {confirming ? (
        <div className="mt-3 space-y-3 rounded-md border border-status-pending/40 bg-status-pending/5 p-3">
          <p className="text-sm">
            <strong>This will let {label} charge you.</strong> Everything up to now has been free.
          </p>

          <label className="block text-sm">
            <span className="mb-1 block font-medium">Most it may spend per day</span>
            <Input
              value={dailyDollars}
              inputMode="decimal"
              placeholder="2.00"
              disabled={busy}
              onChange={(event) => {
                setDailyDollars(event.target.value);
                setError(null);
              }}
              className="max-w-[10rem]"
            />
            <span className="mt-1 block text-xs text-ink-muted">
              In dollars. Leave empty to use only this deployment&rsquo;s own limit. Whichever is
              lower applies.
            </span>
          </label>

          <p className="text-sm text-ink-muted">
            {dailyDollars.trim() === ''
              ? 'With no limit of its own, only the deployment-wide limit applies.'
              : `It will stop once it has spent $${dailyDollars.trim()} in a day, and fall back to the free version.`}
          </p>

          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void send(true)}>
              {busy ? 'Turning on…' : 'Yes, turn it on'}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-xs text-status-danger" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function formatDollars(cents: number): string {
  const dollars = cents / 100;
  return `$${Number.isInteger(dollars) ? dollars.toString() : dollars.toFixed(2)}`;
}

'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/primitives';

/**
 * The buttons that run the engine.
 *
 * Each one costs an AI call, so the control disables itself while working and
 * says what it is doing. It reports failures where the button is rather than
 * as a toast that disappears: "we could not write ads because every draft
 * claimed more than your site says" is the most useful thing this screen can
 * ever tell someone, and it must not vanish after three seconds.
 */
export function MarketingControl({
  businessId,
  action,
  label,
  busyLabel,
  variant = 'primary',
  payload,
}: {
  businessId: string;
  action: 'analyse' | 'strategies' | 'copy' | 'offers';
  label: string;
  busyLabel: string;
  variant?: 'primary' | 'secondary';
  payload?: Record<string, string>;
}): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/businesses/${businessId}/marketing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      });

      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          typeof body === 'object' && body !== null && 'error' in body
            ? ((body as { error?: { message?: string } }).error?.message ?? 'Something went wrong.')
            : 'Something went wrong.';
        setError(message);
        return;
      }

      // The server rendered this page, so refreshing is what shows the result.
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button variant={variant} onClick={run} disabled={busy}>
        {busy ? busyLabel : label}
      </Button>
      {error ? (
        <p className="max-w-xs text-right text-xs text-status-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

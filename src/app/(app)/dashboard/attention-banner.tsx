'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * "N things need your input", with a way to say they no longer do.
 *
 * The automatic resolution covers the conditions some code can notice ending —
 * a scan succeeding, a pause lifting. Everything else stayed flagged forever,
 * so a real dashboard kept insisting three things needed input long after all
 * three were dealt with. A question that cannot be answered stops being read,
 * and then the one that matters is missed too.
 *
 * Marking handled resolves, never deletes: the entries stay in the feed,
 * because they happened.
 */
export function AttentionBanner({ businessId, count }: { businessId: string; count: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/businesses/${businessId}/attention`, { method: 'POST' });
      if (!response.ok) {
        setError('Could not clear those.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-5 rounded-lg border border-status-pending/40 bg-status-pending/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="flex items-start gap-3 text-sm">
          <span aria-hidden="true">❓</span>
          <span>
            <strong>
              {count} {count === 1 ? 'thing needs' : 'things need'} your input.
            </strong>{' '}
            <span className="text-ink-muted">See the activity below.</span>
          </span>
        </p>
        <button
          type="button"
          onClick={() => void clear()}
          disabled={busy}
          className="shrink-0 text-xs text-accent underline-offset-2 hover:underline disabled:opacity-60"
        >
          {busy ? 'Clearing…' : 'Already handled'}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-status-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

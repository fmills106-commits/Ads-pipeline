'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Input } from '@/components/ui/primitives';

/**
 * Renaming the business.
 *
 * Small, and it was missing. A business set up as "Apple" while testing kept
 * saying "Apple sells products described on its own website" after its website
 * had been pointed somewhere else entirely — which reads like the analysis
 * being stale, when in fact it was a name nobody could change.
 *
 * Inline rather than a page of its own: it sits in the row that already shows
 * the name, so changing it happens where you noticed it was wrong.
 */
export function BusinessName({ businessId, name }: { businessId: string; name: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const next = value.trim();
    if (next === '' || next === name) {
      setEditing(false);
      setValue(name);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/businesses/${businessId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? 'Could not save that name.');
        return;
      }

      setEditing(false);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span>{name}</span>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="text-xs text-accent underline-offset-2 hover:underline"
        >
          Rename
        </button>
      </span>
    );
  }

  return (
    <span className="block">
      <span className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          maxLength={200}
          autoFocus
          disabled={busy}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
            if (event.key === 'Escape') {
              setEditing(false);
              setValue(name);
              setError(null);
            }
          }}
          className="max-w-xs"
        />
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setEditing(false);
            setValue(name);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </span>
      {error ? (
        <span className="mt-1 block text-xs text-status-danger" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

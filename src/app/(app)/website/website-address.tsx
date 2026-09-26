'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card, Field, Input } from '@/components/ui/primitives';

/**
 * Changing or removing the website address.
 *
 * Both actions throw away everything read from the old site, so both ask first
 * — and the confirmation says what will go, counted from what is actually
 * there. "This cannot be undone" alone is not informed consent; "your 12
 * products and 27 facts will be removed" is.
 *
 * The form is collapsed by default. An owner visits this page to look at what
 * was found, not to change the address, and a destructive control sitting open
 * next to the results is one mis-click from an afternoon's work.
 */
export function WebsiteAddress({
  businessId,
  websiteUrl,
  knowledge,
}: {
  businessId: string;
  websiteUrl: string | null;
  /** What exists right now, so the warning can be specific. */
  knowledge: { products: number; facts: number };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [value, setValue] = useState(websiteUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasKnowledge = knowledge.products > 0 || knowledge.facts > 0;

  async function submit(nextUrl: string | null) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/businesses/${businessId}/website`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ websiteUrl: nextUrl }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? 'Could not change the website address.');
        return;
      }

      setOpen(false);
      setConfirming(false);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Card className="mb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Website address</h2>
            <p className="truncate text-sm text-ink-muted">{websiteUrl ?? 'Not set'}</p>
          </div>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Change
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-5">
      <h2 className="mb-3 text-sm font-semibold">Change your website address</h2>

      <div className="max-w-xl space-y-4">
        <Field
          label="Website address"
          hint="The address people visit to buy from you, including https://"
          {...(error ? { error } : {})}
        >
          <Input
            type="url"
            inputMode="url"
            value={value}
            placeholder="https://example.com"
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            disabled={busy}
          />
        </Field>

        {hasKnowledge ? (
          <p className="rounded-md border border-status-pending/30 bg-status-pending/5 p-3 text-sm">
            Changing the address removes{' '}
            <strong>
              {knowledge.products > 0
                ? `${knowledge.products} product${knowledge.products === 1 ? '' : 's'}`
                : null}
              {knowledge.products > 0 && knowledge.facts > 0 ? ' and ' : null}
              {knowledge.facts > 0
                ? `${knowledge.facts} thing${knowledge.facts === 1 ? '' : 's'} we learned`
                : null}
            </strong>
            , along with any advertising written from them. They describe the old site, so keeping
            them would mean advertising the wrong company.
          </p>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void submit(value.trim() === '' ? null : value.trim())}
            disabled={busy || value.trim() === (websiteUrl ?? '')}
          >
            {busy ? 'Saving…' : 'Save new address'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(false);
              setConfirming(false);
              setValue(websiteUrl ?? '');
              setError(null);
            }}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>

        {websiteUrl ? (
          <div className="border-t border-border-subtle pt-4">
            {confirming ? (
              <div className="space-y-2">
                <p className="text-sm">
                  Remove <strong>{websiteUrl}</strong> and everything read from it?
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="danger" onClick={() => void submit(null)} disabled={busy}>
                    {busy ? 'Removing…' : 'Yes, remove it'}
                  </Button>
                  <Button variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
                    Keep it
                  </Button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={busy}
                className="text-sm text-status-danger underline underline-offset-2 disabled:opacity-60"
              >
                Remove this website instead
              </button>
            )}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

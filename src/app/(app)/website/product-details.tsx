'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Input } from '@/components/ui/primitives';

/**
 * Telling the engine about one product, in the owner's own words.
 *
 * The two fields here are the two the engine can never work out for itself,
 * and the reason ad copy read "Full Case. See the details and decide for
 * yourself." for a box of soft-foam Halloween squishies: the page said only a
 * name and a price, and everything that makes the product worth buying lived
 * in prose that belonged to no product in particular.
 *
 * Collapsed by default, and the prompt is a question rather than a label —
 * "what is it, and who is it for?" gets a usable sentence; "Description" gets
 * an empty box.
 */
export function ProductDetails({
  businessId,
  productId,
  productName,
  pageDescription,
  ownerDescription,
  costCents,
  priceCents,
  currency,
}: {
  businessId: string;
  productId: string;
  productName: string;
  /** What the page said, shown so the owner can see what they are replacing. */
  pageDescription: string | null;
  ownerDescription: string | null;
  costCents: number | null;
  priceCents: number | null;
  currency: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(ownerDescription ?? '');
  const [cost, setCost] = useState(costCents === null ? '' : (costCents / 100).toFixed(2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const described = ownerDescription !== null && ownerDescription !== '';

  async function save() {
    setBusy(true);
    setError(null);

    const trimmedCost = cost.trim();
    let costPayload: number | null = null;
    if (trimmedCost !== '') {
      const parsed = Math.round(Number(trimmedCost) * 100);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setError('Enter a cost like 4.50, or leave it empty.');
        setBusy(false);
        return;
      }
      costPayload = parsed;
    }

    try {
      const response = await fetch(`/api/businesses/${businessId}/products/${productId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ownerDescription: text.trim(), costCents: costPayload }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? 'Could not save that.');
        return;
      }

      setOpen(false);
      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 text-xs text-accent underline-offset-2 hover:underline"
      >
        {described ? 'Edit your description' : 'Tell us about this one'}
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-3 rounded-md border border-border-subtle bg-surface-muted p-3">
      <label className="block text-sm">
        <span className="mb-1 block font-medium">What is {productName}, and who is it for?</span>
        <textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setError(null);
          }}
          disabled={busy}
          rows={4}
          maxLength={2000}
          placeholder="Soft foam squishies that rise back slowly. Twelve Halloween designs, wrapped so you don't know which you'll get. Ages 14+."
          className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
        />
        <span className="mt-1 block text-xs text-ink-muted">
          Plain sentences are best. This is used when writing your ads, and it outranks whatever we
          read off your page.
        </span>
      </label>

      {pageDescription ? (
        <p className="text-xs text-ink-muted">
          Your page says: &ldquo;{pageDescription.slice(0, 200)}
          {pageDescription.length > 200 ? '…' : ''}&rdquo;
        </p>
      ) : (
        <p className="text-xs text-ink-muted">
          We found no description for this one on your website, which is why your own words matter
          here.
        </p>
      )}

      <label className="block text-sm">
        <span className="mb-1 block font-medium">What does one cost you?</span>
        <Input
          value={cost}
          inputMode="decimal"
          placeholder="4.50"
          disabled={busy}
          onChange={(event) => {
            setCost(event.target.value);
            setError(null);
          }}
          className="max-w-[10rem]"
        />
        <span className="mt-1 block text-xs text-ink-muted">
          Optional, and never shown in an advert.{' '}
          {priceCents === null
            ? 'Without it we cannot work out whether a discount would lose you money, so none will be suggested.'
            : `You sell it for ${formatMoney(priceCents, currency)}. Without your cost we cannot tell whether a discount would lose you money, so none will be suggested.`}
        </span>
      </label>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setText(ownerDescription ?? '');
            setCost(costCents === null ? '' : (costCents / 100).toFixed(2));
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>

      {error ? (
        <p className="text-xs text-status-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  const shown = Number.isInteger(amount) ? amount.toString() : amount.toFixed(2);
  return currency === 'USD' ? `$${shown}` : `${shown} ${currency}`;
}

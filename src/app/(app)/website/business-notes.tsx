'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Card } from '@/components/ui/primitives';

/**
 * What the owner would tell a new employee on their first day.
 *
 * A website is written to sell to a visitor who is already interested. It
 * rarely states the things an advertiser most needs: who this is really for,
 * what makes it different from the cheap version, what not to say. Those live
 * in the owner's head, and nothing was ever going to scrape them.
 *
 * Deliberately one open box rather than a form of fields. A form of fields
 * ("target audience", "USP", "tone") gets each box filled with the words the
 * label suggested; one honest question gets a paragraph that actually says
 * something. It goes to the analyser and to every ad written afterwards,
 * labelled as the owner's own words so nothing here is mistaken for a fact
 * read off the site.
 */
export function BusinessNotes({ businessId, notes }: { businessId: string; notes: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/businesses/${businessId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: text.trim() }),
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
      <Card className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">In your own words</h2>
            {notes ? (
              <p className="mt-1 whitespace-pre-line text-sm text-ink-muted">{notes}</p>
            ) : (
              <p className="mt-1 text-sm text-ink-muted">
                Your website is written for someone already interested. Tell us the things it
                doesn&rsquo;t say — who really buys this, what makes it different, anything we
                should never claim. It goes into every ad we write.
              </p>
            )}
          </div>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {notes ? 'Edit' : 'Add'}
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="mb-5">
      <h2 className="mb-1 text-sm font-semibold">In your own words</h2>
      <p className="mb-3 text-sm text-ink-muted">
        Imagine telling someone on their first day what you sell and who buys it. Plain sentences.
      </p>
      <textarea
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        disabled={busy}
        rows={6}
        maxLength={4000}
        placeholder="We make soft foam squishies that rise back slowly — the good kind, not the cheap hard ones. Twelve Halloween designs, wrapped so it's a surprise which you get. Mostly bought by teenagers and collectors, and by parents for party bags. Never say they're edible."
        className="w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setText(notes ?? '');
            setError(null);
          }}
        >
          Cancel
        </Button>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-status-danger" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  );
}

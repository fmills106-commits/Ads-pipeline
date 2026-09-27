'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/primitives';

/**
 * What this product looks like, and the prompt to make a picture of it.
 *
 * This screen exists because of one image. An owner took the engine's reading
 * of their shop — accurate about the foam, the size, the sealed wrappers, the
 * twelve designs — pasted it into an image generator, and got back a bow-tied
 * black cat and a Frankenstein head. They sell neither.
 *
 * Nothing had gone wrong with the writing. Ad copy has nowhere to put
 * appearance, so the generator filled the silence with the most generic
 * Halloween imagery available. The fix is not a longer ad; it is a different
 * output, and the part of it that does the work is the list of things the
 * picture must not contain.
 *
 * Two things this screen is careful about:
 *
 *  - **It says whether anything actually looked.** A brief written from words
 *    alone is a guess about appearance, and is labelled as one rather than
 *    reading like an observation.
 *  - **The prompt is copyable in one press.** This output's whole purpose is to
 *    be pasted somewhere else, and an owner reading it off the screen and
 *    retyping it would drop exactly the specifics it exists to carry.
 */
export interface VisualBrief {
  seen: boolean;
  looksLike: string;
  colours: string[];
  form: string;
  packaging?: string;
  printedText: string[];
  scale?: string;
  doNotShow: string[];
  imagePrompt: string;
}

export function ProductLook({
  businessId,
  productId,
  productName,
  brief,
  writtenAt,
}: {
  businessId: string;
  productId: string;
  productName: string;
  brief: VisualBrief | null;
  writtenAt: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function describe() {
    setBusy(true);
    setError(null);

    try {
      const response = await fetch(`/api/businesses/${businessId}/products/${productId}/look`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? 'Could not describe this product.');
        return;
      }

      router.refresh();
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  async function copyPrompt() {
    if (!brief) return;
    try {
      await navigator.clipboard.writeText(brief.imagePrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard permission is refused in some browsers and every embedded
      // view. The prompt is on screen and selectable, so this is a missing
      // convenience rather than a missing feature.
      setError('Could not copy automatically — select the text and copy it.');
    }
  }

  return (
    <div className="mt-3 border-t border-border-subtle pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">How it looks</p>
        <Button variant="secondary" disabled={busy} onClick={() => void describe()}>
          {busy ? 'Looking…' : brief ? 'Look again' : 'Describe how it looks'}
        </Button>
      </div>

      {!brief ? (
        <p className="mt-2 text-sm text-ink-muted">
          Writes down what {productName} actually looks like — shape, colours, packaging, what is
          printed on it — and turns it into a prompt you can paste into an image tool. Reads your
          own photographs where it can.
        </p>
      ) : (
        <div className="mt-3 space-y-3 text-sm">
          <p
            className={
              brief.seen
                ? 'inline-block rounded-full bg-status-ok/10 px-2.5 py-0.5 text-xs font-medium text-status-ok'
                : 'inline-block rounded-full bg-status-pending/10 px-2.5 py-0.5 text-xs font-medium text-status-pending'
            }
          >
            {brief.seen
              ? 'Written from your photographs'
              : 'Written from your words — no pictures were read'}
          </p>

          <p>{brief.looksLike}</p>

          <dl className="grid gap-x-3 gap-y-1 sm:grid-cols-[8rem_1fr]">
            <dt className="text-ink-muted">Shape</dt>
            <dd>{brief.form}</dd>
            {brief.colours.length > 0 ? (
              <>
                <dt className="text-ink-muted">Colours</dt>
                <dd>{brief.colours.join(', ')}</dd>
              </>
            ) : null}
            {brief.packaging ? (
              <>
                <dt className="text-ink-muted">Packaging</dt>
                <dd>{brief.packaging}</dd>
              </>
            ) : null}
            {brief.printedText.length > 0 ? (
              <>
                <dt className="text-ink-muted">Printed on it</dt>
                <dd>{brief.printedText.join(', ')}</dd>
              </>
            ) : null}
            {brief.scale ? (
              <>
                <dt className="text-ink-muted">Size</dt>
                <dd>{brief.scale}</dd>
              </>
            ) : null}
          </dl>

          {brief.doNotShow.length > 0 ? (
            <div className="rounded-md border border-status-pending/40 bg-status-pending/5 p-3">
              <p className="mb-1 font-medium">A picture of this must not show</p>
              <ul className="list-disc space-y-0.5 pl-5 text-ink-muted">
                {brief.doNotShow.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">Prompt for an image tool</p>
              <Button variant="secondary" onClick={() => void copyPrompt()}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="whitespace-pre-wrap rounded-md border border-border-subtle bg-surface-muted p-3 font-mono text-xs">
              {brief.imagePrompt}
            </p>
          </div>

          {writtenAt ? (
            <p className="text-xs text-ink-muted">
              Written {new Date(writtenAt).toLocaleString()}. Press “Look again” after you change
              your photographs.
            </p>
          ) : null}
        </div>
      )}

      {error ? (
        <p className="mt-2 text-xs text-status-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

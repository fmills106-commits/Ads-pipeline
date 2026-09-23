'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/primitives';

type Phase = 'idle' | 'queued' | 'crawling' | 'done' | 'failed';

/**
 * Start a scan, then poll until it finishes.
 *
 * A crawl takes tens of seconds and cannot report a percentage — it does not
 * know how many pages exist until it has found them. So the progress shown is
 * the honest one: how many pages have been read so far.
 */
export function ScanControl({
  businessId,
  initialPhase,
}: {
  businessId: string;
  initialPhase: Phase;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const running = phase === 'queued' || phase === 'crawling';

  const poll = useCallback(async () => {
    try {
      const response = await fetch(`/api/businesses/${businessId}/scan`, { cache: 'no-store' });
      if (!response.ok) return;

      const payload = (await response.json()) as {
        data?: { phase: Phase; pagesFetched: number };
      };
      const next = payload.data?.phase;
      if (!next) return;

      setPages(payload.data?.pagesFetched ?? 0);
      setPhase(next);

      if (next === 'queued' || next === 'crawling') {
        timer.current = setTimeout(() => void poll(), 2_000);
      } else {
        // Finished: re-render the server component so results appear.
        router.refresh();
      }
    } catch {
      // A failed poll is not a failed scan; try again on the next tick.
      timer.current = setTimeout(() => void poll(), 4_000);
    }
  }, [businessId, router]);

  useEffect(() => {
    if (running) timer.current = setTimeout(() => void poll(), 1_500);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // Only (re)start polling when the running state flips.
  }, [running, poll]);

  async function start() {
    setError(null);
    setPhase('queued');
    try {
      const response = await fetch(`/api/businesses/${businessId}/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(payload?.error?.message ?? 'Could not start reading your website.');
        setPhase('failed');
        return;
      }

      void poll();
    } catch {
      setError('Could not reach the server.');
      setPhase('failed');
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button onClick={start} disabled={running}>
        {phase === 'queued'
          ? 'Starting…'
          : phase === 'crawling'
            ? `Reading… ${pages} ${pages === 1 ? 'page' : 'pages'}`
            : phase === 'done'
              ? 'Read it again'
              : 'Read my website'}
      </Button>
      {error ? (
        <p className="text-xs text-status-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

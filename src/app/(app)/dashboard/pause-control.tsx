'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/primitives';

/**
 * PAUSE EVERYTHING.
 *
 * One button, always in the same place, always reachable. Pausing takes one
 * click and no confirmation — hesitating in front of a dialog is the wrong
 * thing to make someone do when they want spending to stop. Resuming asks for
 * confirmation, because that is the direction that starts spending again.
 */
export function PauseControl({ businessId, paused }: { businessId: string; paused: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmingResume, setConfirmingResume] = useState(false);

  async function send(action: 'pause' | 'resume') {
    setBusy(true);
    try {
      await fetch(`/api/businesses/${businessId}/pause`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      router.refresh();
    } finally {
      setBusy(false);
      setConfirmingResume(false);
    }
  }

  if (!paused) {
    return (
      <Button variant="danger" disabled={busy} onClick={() => send('pause')}>
        {busy ? 'Pausing…' : 'Pause everything'}
      </Button>
    );
  }

  if (confirmingResume) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-ink-muted">Start advertising again?</span>
        <Button variant="secondary" onClick={() => setConfirmingResume(false)} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => send('resume')} disabled={busy}>
          {busy ? 'Resuming…' : 'Yes, resume'}
        </Button>
      </div>
    );
  }

  return (
    <Button variant="secondary" onClick={() => setConfirmingResume(true)} disabled={busy}>
      Resume advertising
    </Button>
  );
}

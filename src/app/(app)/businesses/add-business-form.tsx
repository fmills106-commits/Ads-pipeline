'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';

export function AddBusinessForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const form = event.currentTarget;
    const data = new FormData(form);

    try {
      const response = await fetch('/api/businesses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          workspaceId,
          name: String(data.get('name') ?? ''),
          industry: emptyToUndefined(data.get('industry')),
          websiteUrl: emptyToUndefined(data.get('websiteUrl')),
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? 'Could not create the business.');
        return;
      }

      form.reset();
      router.refresh();
    } catch {
      setError('Could not reach the server. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      <Field label="Business name">
        <Input name="name" required maxLength={200} />
      </Field>
      <Field label="Industry" hint="Optional. Free text — any industry.">
        <Input name="industry" maxLength={120} />
      </Field>
      <Field label="Website URL" hint="Optional. Must be a public http(s) address.">
        <Input name="websiteUrl" type="url" placeholder="https://" maxLength={2048} />
      </Field>

      {error ? (
        <p className="text-sm text-status-danger" role="alert">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Adding…' : 'Add business'}
      </Button>
    </form>
  );
}

function emptyToUndefined(value: FormDataEntryValue | null): string | undefined {
  const text = String(value ?? '').trim();
  return text.length === 0 ? undefined : text;
}

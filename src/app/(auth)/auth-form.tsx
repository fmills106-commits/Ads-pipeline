'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input } from '@/components/ui/primitives';
import { PASSWORD_MIN_LENGTH } from '@/lib/auth-constants';

/**
 * Login and registration share one form: the fields differ by a single input
 * and the error handling is identical, so two components would be two places
 * to fix the same bug.
 */
export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === 'register';

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const form = new FormData(event.currentTarget);
    const payload = {
      email: String(form.get('email') ?? ''),
      password: String(form.get('password') ?? ''),
      ...(isRegister ? { name: String(form.get('name') ?? '') } : {}),
    };

    try {
      const response = await fetch(`/api/auth/${isRegister ? 'register' : 'login'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? 'Something went wrong. Please try again.');
        return;
      }

      // The session cookie is set by the route; refresh so server components
      // re-render with the authenticated user before navigating.
      router.refresh();
      router.push('/dashboard');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {isRegister ? (
        <Field label="Your name">
          <Input name="name" autoComplete="name" required maxLength={120} />
        </Field>
      ) : null}

      <Field label="Email">
        <Input name="email" type="email" autoComplete="email" required maxLength={320} />
      </Field>

      <Field
        label="Password"
        hint={isRegister ? `At least ${PASSWORD_MIN_LENGTH} characters.` : undefined}
      >
        <Input
          name="password"
          type="password"
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          required
          minLength={isRegister ? PASSWORD_MIN_LENGTH : undefined}
          maxLength={256}
        />
      </Field>

      {error ? (
        <p className="text-sm text-status-danger" role="alert">
          {error}
        </p>
      ) : null}

      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? 'Working…' : isRegister ? 'Create account' : 'Sign in'}
      </Button>
    </form>
  );
}

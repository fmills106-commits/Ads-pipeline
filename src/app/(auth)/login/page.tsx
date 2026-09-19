import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Card } from '@/components/ui/primitives';
import { getCurrentUser } from '@/server/auth/current-user';
import { AuthForm } from '../auth-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect('/dashboard');

  return (
    <Card>
      <h1 className="mb-1 text-lg font-semibold">Sign in</h1>
      <p className="mb-5 text-sm text-ink-muted">Continue to your workspace.</p>
      <AuthForm mode="login" />
      <p className="mt-4 text-center text-sm text-ink-muted">
        No account?{' '}
        <Link className="font-medium text-accent hover:underline" href="/register">
          Create one
        </Link>
      </p>
    </Card>
  );
}

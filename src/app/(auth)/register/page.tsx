import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { Card } from '@/components/ui/primitives';
import { getCurrentUser } from '@/server/auth/current-user';
import { AuthForm } from '../auth-form';

export const metadata: Metadata = { title: 'Create account' };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect('/dashboard');

  return (
    <Card>
      <h1 className="mb-1 text-lg font-semibold">Create your account</h1>
      <p className="mb-5 text-sm text-ink-muted">
        A workspace is created for you. You can add businesses to it next.
      </p>
      <AuthForm mode="register" />
      <p className="mt-4 text-center text-sm text-ink-muted">
        Already have an account?{' '}
        <Link className="font-medium text-accent hover:underline" href="/login">
          Sign in
        </Link>
      </p>
    </Card>
  );
}

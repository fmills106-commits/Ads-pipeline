import { cookies } from 'next/headers';
import type { User } from '@prisma/client';
import { unauthenticated } from '@/lib/errors';
import { SESSION_COOKIE_NAME, resolveSession } from './session';

/**
 * Request-scoped access to the signed-in user.
 *
 * Kept separate from `session.ts` because that module is pure and testable
 * without a request; this one touches `next/headers` and therefore only runs
 * inside a server component, route handler, or server action.
 */

export async function getCurrentUser(): Promise<User | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const resolved = await resolveSession(token);
  return resolved?.user ?? null;
}

export async function requireCurrentUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw unauthenticated('Authentication required');
  return user;
}

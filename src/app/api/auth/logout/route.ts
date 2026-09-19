import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { route } from '@/server/api/handler';
import { SESSION_COOKIE_NAME, destroySession } from '@/server/auth/session';

/**
 * Signing out is deliberately reachable without an auth check: a session that
 * is already invalid should still clear the cookie rather than return 401.
 */
export const POST = route({ requireAuth: false }, async () => {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (token) await destroySession(token);

  const response = NextResponse.json({ data: { signedOut: true } });
  response.cookies.set(SESSION_COOKIE_NAME, '', { path: '/', maxAge: 0 });
  return response;
});

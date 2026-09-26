'use server';

import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { isTheme, THEME_COOKIE, THEME_COOKIE_MAX_AGE } from '@/lib/theme';

/**
 * Records the light/dark choice.
 *
 * A server action rather than an API route and a click handler, so the control
 * is a plain form that works before JavaScript loads and does not need a
 * nonce. The cookie is written server-side, which is also what lets the next
 * render emit the right theme in its HTML.
 *
 * Deliberately not `httpOnly`: this is a display preference, not a credential,
 * and a future client-side control should be able to read it. `sameSite: lax`
 * so it survives following a link into the app.
 */
export async function setTheme(formData: FormData): Promise<void> {
  const requested = formData.get('theme');

  // A junk value is ignored rather than stored. `parseTheme` would fall back
  // on read anyway, but keeping the cookie clean means the stored value always
  // means what it says.
  if (!isTheme(requested)) return;

  (await cookies()).set(THEME_COOKIE, requested, {
    maxAge: THEME_COOKIE_MAX_AGE,
    path: '/',
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  });

  // The root layout reads the cookie, so every route's markup changes.
  revalidatePath('/', 'layout');
}

/**
 * The light/dark choice.
 *
 * The palette already follows `prefers-color-scheme`, so dark mode worked from
 * the start for anyone whose device is set to dark. What was missing is the
 * ability to disagree with the device — which is a real need, not a
 * preference: people work on a bright device in a dark room and the reverse,
 * and a business owner checking ad spend at night should not have to change an
 * operating-system setting to do it.
 *
 * `system` stays the default and means "keep following the device", not "light".
 *
 * The choice is kept in a cookie rather than `localStorage` because the server
 * renders the page. A cookie arrives with the request, so the correct theme is
 * in the HTML that is sent; `localStorage` can only be read after JavaScript
 * runs, which means one frame of the wrong colours on every single page load.
 * The usual fix for that is a blocking inline script, and this application's
 * content-security-policy allows no inline script without a nonce. Reading a
 * cookie server-side avoids needing one at all.
 */

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = 'theme';
export const DEFAULT_THEME: Theme = 'system';

/** A year: long enough that nobody re-picks, short enough to expire eventually. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

/** Whatever the cookie says, or the default. Never throws on a junk value. */
export function parseTheme(value: string | undefined): Theme {
  return isTheme(value) ? value : DEFAULT_THEME;
}

/**
 * The `data-theme` attribute for `<html>`.
 *
 * `system` sets no attribute, so the `prefers-color-scheme` rules in
 * globals.css apply unchanged. An explicit choice sets the attribute, and the
 * CSS rules keyed on it win over the media query.
 */
export function themeAttribute(theme: Theme): Record<string, string> {
  return theme === 'system' ? {} : { 'data-theme': theme };
}

export const THEME_LABELS: Record<Theme, string> = {
  system: 'Match my device',
  light: 'Light',
  dark: 'Dark',
};

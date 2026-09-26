import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, isTheme, parseTheme, themeAttribute, THEMES } from '@/lib/theme';

/**
 * The theme choice.
 *
 * Worth testing despite being three strings, because two of the properties are
 * ones a mistake makes invisible rather than obvious: that "follow my device"
 * emits no attribute (so the media query still applies), and that a junk
 * cookie renders the app rather than breaking the root layout — which is the
 * one component whose failure has no error page to show.
 */

describe('parseTheme', () => {
  it('accepts the three real values', () => {
    for (const theme of THEMES) expect(parseTheme(theme)).toBe(theme);
  });

  it('falls back to following the device', () => {
    // A cookie is attacker-supplied input: it arrives on the request and the
    // root layout renders from it before anything else runs.
    for (const junk of [undefined, '', 'DARK', 'midnight', '../../etc/passwd', '{}']) {
      expect(parseTheme(junk)).toBe('system');
    }
    expect(DEFAULT_THEME).toBe('system');
  });
});

describe('themeAttribute', () => {
  it('sets nothing for "system", so prefers-color-scheme still decides', () => {
    // The whole design rests on this: an attribute of data-theme="system"
    // would match neither CSS rule and silently pin everyone to light.
    expect(themeAttribute('system')).toEqual({});
  });

  it('names the chosen theme otherwise', () => {
    expect(themeAttribute('dark')).toEqual({ 'data-theme': 'dark' });
    expect(themeAttribute('light')).toEqual({ 'data-theme': 'light' });
  });
});

describe('isTheme', () => {
  it('rejects anything that is not one of the three', () => {
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('auto')).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme(0)).toBe(false);
  });
});

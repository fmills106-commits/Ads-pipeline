import { describe, expect, it } from 'vitest';
import { slugify } from '@/lib/slug';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Alpine Coffee Roasters')).toBe('alpine-coffee-roasters');
  });

  it('strips diacritics rather than dropping the letters', () => {
    expect(slugify('Café Noël')).toBe('cafe-noel');
  });

  it('drops apostrophes instead of turning them into hyphens', () => {
    expect(slugify("Owner's Workspace")).toBe('owners-workspace');
    expect(slugify('Owner’s Workspace')).toBe('owners-workspace');
  });

  it('collapses runs of punctuation and trims edges', () => {
    expect(slugify('  --Harbour & Marine // Supply--  ')).toBe('harbour-marine-supply');
  });

  it('truncates without leaving a trailing hyphen', () => {
    const slug = slugify('a'.repeat(40) + ' ' + 'b'.repeat(40), 41);
    expect(slug.length).toBeLessThanOrEqual(41);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('returns an empty string when nothing survives — callers supply a fallback', () => {
    expect(slugify('日本語')).toBe('');
    expect(slugify('!!!')).toBe('');
  });
});

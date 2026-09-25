import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import {
  consume,
  enforce,
  purgeExpiredRateLimits,
  RATE_LIMITS,
  type RateLimitRule,
} from '@/server/api/rate-limit';
import { resetDatabase } from '../helpers/db';

/**
 * Rate limiting is the control standing between a public deployment and
 * somebody working through a password list, so the properties worth asserting
 * are the ones a naive implementation gets wrong: the boundary between
 * allowed and refused, concurrency, and window expiry.
 */

const rule: RateLimitRule = { action: 'test', limit: 3, windowMs: 60_000 };

beforeEach(async () => {
  await resetDatabase();
});

describe('consume', () => {
  it('allows requests up to the limit and refuses the next', async () => {
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await consume(rule, 'subject'));

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
  });

  it('reports how many are left', async () => {
    expect((await consume(rule, 's')).remaining).toBe(2);
    expect((await consume(rule, 's')).remaining).toBe(1);
    expect((await consume(rule, 's')).remaining).toBe(0);
    // Never negative, however far over the limit the caller goes.
    expect((await consume(rule, 's')).remaining).toBe(0);
  });

  it('counts each subject separately', async () => {
    for (let i = 0; i < 3; i += 1) await consume(rule, 'noisy');

    expect((await consume(rule, 'noisy')).allowed).toBe(false);
    expect((await consume(rule, 'quiet')).allowed).toBe(true);
  });

  it('counts each action separately', async () => {
    for (let i = 0; i < 3; i += 1) await consume(rule, 'shared');

    const other: RateLimitRule = { ...rule, action: 'other' };
    expect((await consume(other, 'shared')).allowed).toBe(true);
  });

  it('does not miscount under concurrency', async () => {
    // The property the single atomic upsert exists to provide. Two requests
    // must not both read the same count and both decide they are under it.
    const results = await Promise.all(Array.from({ length: 10 }, () => consume(rule, 'racer')));

    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it('starts a fresh window once the old one passes', async () => {
    const start = new Date('2026-01-01T12:00:00.000Z');
    for (let i = 0; i < 3; i += 1) await consume(rule, 's', prisma, start);
    expect((await consume(rule, 's', prisma, start)).allowed).toBe(false);

    const later = new Date(start.getTime() + rule.windowMs);
    expect((await consume(rule, 's', prisma, later)).allowed).toBe(true);
  });

  it('reports seconds until the window resets', async () => {
    // Windows are truncated to their size, so a call 10s into a 60s window
    // has 50s left — not 60.
    const at = new Date('2026-01-01T12:00:10.000Z');
    expect((await consume(rule, 's', prisma, at)).retryAfterSeconds).toBe(50);
  });

  it('keeps one row per subject rather than one per request', async () => {
    for (let i = 0; i < 5; i += 1) await consume(rule, 's');
    expect(await prisma.rateLimit.count()).toBe(1);
  });
});

describe('enforce', () => {
  it('is silent while under the limit', async () => {
    await expect(enforce(rule, 's')).resolves.toBeUndefined();
  });

  it('throws RATE_LIMITED with a retry hint once over', async () => {
    for (let i = 0; i < 3; i += 1) await enforce(rule, 's');

    // The hint travels on the error so the route wrapper can set Retry-After;
    // a 429 without one just invites an immediate retry.
    await expect(enforce(rule, 's')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      status: 429,
      details: { retryAfterSeconds: expect.any(Number) },
    });
  });
});

describe('the configured limits', () => {
  it('are tight enough on login to matter', () => {
    // Credential stuffing is the threat being priced out here.
    expect(RATE_LIMITS.login.limit).toBeLessThanOrEqual(10);
    expect(RATE_LIMITS.login.windowMs).toBeGreaterThanOrEqual(10 * 60 * 1000);
  });

  it('limit scans, which fetch somebody else’s server', () => {
    expect(RATE_LIMITS.scan.limit).toBeLessThanOrEqual(20);
  });

  it('leave a generous backstop for ordinary use', () => {
    // A real person clicking around must never hit this.
    expect(RATE_LIMITS.api.limit).toBeGreaterThanOrEqual(100);
  });
});

describe('purgeExpiredRateLimits', () => {
  it('deletes spent windows and keeps live ones', async () => {
    const past = new Date('2026-01-01T12:00:00.000Z');
    await consume(rule, 'old', prisma, past);
    await consume(rule, 'current');

    const removed = await purgeExpiredRateLimits();

    expect(removed).toBe(1);
    expect(await prisma.rateLimit.count()).toBe(1);
  });
});

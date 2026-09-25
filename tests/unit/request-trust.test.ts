import { afterEach, describe, expect, it } from 'vitest';
import { clientIp, trustedIpHeader } from '@/server/api/request';
import { resetEnvCache } from '@/lib/env';

/**
 * Which header carries the client's address is a trust decision, and getting
 * it wrong is not cosmetic: rate limiting keyed on a header anyone can set is
 * rate limiting that does nothing. These tests pin the decision to
 * configuration rather than to whatever a request happens to carry.
 */

const withProxy = (value: string | undefined) => {
  if (value === undefined) delete process.env['TRUSTED_PROXY'];
  else process.env['TRUSTED_PROXY'] = value;
  resetEnvCache();
};

const requestWith = (headers: Record<string, string>) =>
  new Request('https://app.example.com/api/thing', { headers });

afterEach(() => {
  withProxy(undefined);
});

describe('with no trusted proxy configured', () => {
  it('reads no address at all', () => {
    withProxy(undefined);

    // Every anonymous caller then shares one counter. That is the safe
    // failure: throttling everyone together beats trusting a forged header.
    expect(clientIp(requestWith({ 'x-forwarded-for': '203.0.113.9' }))).toBeNull();
    expect(clientIp(requestWith({ 'cf-connecting-ip': '203.0.113.9' }))).toBeNull();
    expect(trustedIpHeader()).toBeNull();
  });
});

describe('behind Cloudflare', () => {
  it('reads CF-Connecting-IP', () => {
    withProxy('cloudflare');
    expect(clientIp(requestWith({ 'cf-connecting-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('ignores X-Forwarded-For, which the caller controls', () => {
    withProxy('cloudflare');

    // The attack this defeats: rotating X-Forwarded-For to get a fresh
    // rate-limit bucket on every request.
    expect(clientIp(requestWith({ 'x-forwarded-for': '198.51.100.7' }))).toBeNull();
  });

  it('prefers the trusted header when both are present', () => {
    withProxy('cloudflare');
    const ip = clientIp(
      requestWith({ 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.7' }),
    );
    expect(ip).toBe('203.0.113.9');
  });
});

describe('behind Vercel', () => {
  it('reads X-Real-IP', () => {
    withProxy('vercel');
    expect(clientIp(requestWith({ 'x-real-ip': '203.0.113.4' }))).toBe('203.0.113.4');
  });

  it('does not read Cloudflare’s header on a Vercel deployment', () => {
    withProxy('vercel');
    expect(clientIp(requestWith({ 'cf-connecting-ip': '203.0.113.4' }))).toBeNull();
  });
});

describe('malformed values', () => {
  it('takes the left-most entry of a list', () => {
    withProxy('cloudflare');
    const ip = clientIp(requestWith({ 'cf-connecting-ip': '203.0.113.9, 70.41.3.18' }));
    expect(ip).toBe('203.0.113.9');
  });

  it('returns null for an empty header rather than an empty string', () => {
    withProxy('cloudflare');
    expect(clientIp(requestWith({ 'cf-connecting-ip': '   ' }))).toBeNull();
  });

  it('bounds the length, because this value is stored', () => {
    withProxy('cloudflare');
    const ip = clientIp(requestWith({ 'cf-connecting-ip': 'a'.repeat(500) }));
    expect(ip).toHaveLength(64);
  });

  it('returns null when the proxy header is missing entirely', () => {
    // A direct hit that bypassed the proxy, or a platform that stopped
    // sending it. Unidentifiable, not "trust something else".
    withProxy('cloudflare');
    expect(clientIp(requestWith({}))).toBeNull();
  });
});

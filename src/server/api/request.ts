import { getEnv } from '@/lib/env';

/**
 * Extracts the client IP, for audit records and for rate limiting.
 *
 * Which header to believe is **configured**, not guessed. `X-Forwarded-For`
 * arrives from the open internet and anybody can set it, so a deployment that
 * trusted it unconditionally would let one caller defeat per-IP rate limiting
 * by rotating a header value. Each supported proxy has a header it sets
 * itself and overwrites on every request:
 *
 *   - Cloudflare → `CF-Connecting-IP`
 *   - Vercel     → `X-Real-IP`
 *
 * With `TRUSTED_PROXY=none` (the default) no proxy header is read at all, and
 * callers are not distinguished by address. That is the safe failure: a
 * misconfigured deployment rate-limits everyone together rather than trusting
 * a value an attacker controls.
 *
 * When the header is absent — a direct hit that bypassed the proxy, or a
 * platform that stopped sending it — the result is null, and the caller
 * decides what to do with an unidentifiable client.
 */
export function clientIp(request: Request): string | null {
  const header = trustedIpHeader();
  if (!header) return null;

  const value = request.headers.get(header)?.trim();
  if (!value) return null;

  // Cloudflare and Vercel both send a single address, but take the left-most
  // entry regardless so a comma-separated value can never be stored whole.
  const first = value.split(',')[0]?.trim();
  if (!first) return null;

  return first.slice(0, 64);
}

/** The one header this deployment is configured to believe, if any. */
export function trustedIpHeader(): string | null {
  switch (getEnv().TRUSTED_PROXY) {
    case 'cloudflare':
      return 'cf-connecting-ip';
    case 'vercel':
      return 'x-real-ip';
    default:
      return null;
  }
}

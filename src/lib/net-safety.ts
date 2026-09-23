import { isIP } from 'node:net';
import { validationError } from './errors';

/**
 * Network safety for outbound requests.
 *
 * This platform is *designed* to fetch arbitrary URLs a user supplies, which
 * makes SSRF the highest-risk surface in the whole application. Two gates:
 *
 *  1. `assertSafePublicUrl` — syntactic. Runs the moment a URL is supplied,
 *     long before any fetch.
 *  2. `assertResolvedAddressesArePublic` — runtime. Runs against the *resolved*
 *     IP addresses immediately before connecting, because DNS can point a
 *     perfectly ordinary hostname at 169.254.169.254.
 *
 * Gate 1 alone is not enough, and gate 1 is also easy to get wrong: an earlier
 * version of this code only recognised dotted-quad IPv4 literals, so
 * `http://2130706433/` — which is exactly `http://127.0.0.1/` as far as the
 * network stack is concerned — sailed straight through. Everything below
 * normalises to a numeric address first and classifies that, rather than
 * pattern-matching the text.
 */

/** Result of classifying a host. */
export type HostClass = 'public' | 'private' | 'not-an-ip';

const MAX_URL_LENGTH = 2048;

/**
 * Parses every IPv4 spelling the C `inet_aton` family accepts, which is what
 * browsers, curl and Node all ultimately use:
 *
 *   `127.0.0.1`  dotted quad
 *   `127.1`      2 parts: a.d        (d fills the low 24 bits)
 *   `127.0.1`    3 parts: a.b.d      (d fills the low 16 bits)
 *   `2130706433` 1 part:  the whole 32-bit value
 *
 * and each part may be decimal, `0x`-hex, or leading-zero octal.
 *
 * @returns the address as an unsigned 32-bit number, or null if not IPv4.
 */
export function parseIPv4(host: string): number | null {
  if (host.length === 0) return null;

  const parts = host.split('.');
  if (parts.length > 4) return null;

  const values: number[] = [];
  for (const part of parts) {
    const value = parseNumericPart(part);
    if (value === null) return null;
    values.push(value);
  }

  // The last part absorbs all the remaining low-order bytes.
  const leading = values.slice(0, -1);
  const last = values[values.length - 1]!;
  const remainingBytes = 4 - leading.length;

  if (leading.some((value) => value > 0xff)) return null;
  if (last > 2 ** (8 * remainingBytes) - 1) return null;

  let result = 0;
  for (const value of leading) result = result * 256 + value;
  return result * 2 ** (8 * remainingBytes) + last;
}

function parseNumericPart(part: string): number | null {
  if (part.length === 0) return null;

  let radix = 10;
  let digits = part;

  if (/^0[xX]/.test(part)) {
    radix = 16;
    digits = part.slice(2);
    if (!/^[0-9a-fA-F]+$/.test(digits)) return null;
  } else if (/^0[0-7]+$/.test(part)) {
    radix = 8;
    digits = part.slice(1);
  } else if (!/^\d+$/.test(part)) {
    return null;
  }

  const value = Number.parseInt(digits, radix);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Classifies a 32-bit IPv4 address as public or not-to-be-fetched. */
export function classifyIPv4(address: number): HostClass {
  const a = (address >>> 24) & 0xff;
  const b = (address >>> 16) & 0xff;

  if (a === 0) return 'private'; // 0.0.0.0/8 "this network"
  if (a === 10) return 'private'; // RFC1918
  if (a === 127) return 'private'; // loopback
  if (a === 169 && b === 254) return 'private'; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // RFC1918
  if (a === 192 && b === 168) return 'private'; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT
  if (a === 192 && b === 0) return 'private'; // 192.0.0.0/24 + 192.0.2.0/24 TEST-NET
  if (a === 198 && (b === 18 || b === 19)) return 'private'; // benchmarking
  if (a === 198 && b === 51) return 'private'; // TEST-NET-2
  if (a === 203 && b === 0) return 'private'; // TEST-NET-3
  if (a >= 224) return 'private'; // multicast + reserved + broadcast

  return 'public';
}

/** Classifies an IPv6 address string. */
export function classifyIPv6(host: string): HostClass {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(bare) !== 6) return 'not-an-ip';

  if (bare === '::' || bare === '::1') return 'private'; // unspecified, loopback

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d) carry an
  // embedded IPv4 address, which must be classified as IPv4 or ::ffff:127.0.0.1
  // becomes a loopback bypass.
  const embedded = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(bare);
  if (embedded) {
    const address = parseIPv4(embedded[1]!);
    return address === null ? 'private' : classifyIPv4(address);
  }
  // Same, written in hex groups: ::ffff:7f00:1
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(bare);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1]!, 16);
    const low = Number.parseInt(hexMapped[2]!, 16);
    return classifyIPv4((high << 16) | low);
  }

  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return 'private'; // unique-local fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return 'private'; // link-local fe80::/10
  if (/^ff[0-9a-f]{2}:/.test(bare)) return 'private'; // multicast ff00::/8
  // NAT64 well-known prefix, and 6to4 / Teredo, all of which can tunnel to
  // addresses we would otherwise refuse.
  if (bare.startsWith('64:ff9b:')) return 'private';
  if (bare.startsWith('2002:')) return 'private';
  if (bare.startsWith('2001:0:') || bare.startsWith('2001:db8:')) return 'private';

  return 'public';
}

/** Hostnames that are never fetched regardless of what they resolve to. */
function isBlockedHostname(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  for (const suffix of ['.local', '.internal', '.intranet', '.home.arpa', '.lan']) {
    if (lower.endsWith(suffix)) return true;
  }
  // Cloud metadata services reachable by name.
  if (lower === 'metadata.google.internal' || lower === 'metadata') return true;
  return false;
}

/**
 * Classifies a URL's host without touching the network.
 * `not-an-ip` means "a hostname that must still be checked after DNS".
 */
export function classifyHost(host: string): HostClass {
  if (isBlockedHostname(host)) return 'private';

  const ipv6 = classifyIPv6(host);
  if (ipv6 !== 'not-an-ip') return ipv6;

  const ipv4 = parseIPv4(host);
  if (ipv4 !== null) return classifyIPv4(ipv4);

  return 'not-an-ip';
}

/**
 * Policy overrides for URL validation.
 *
 * `allowedPrivateHosts` exists so the crawler's own test suite can point at a
 * fixture server on 127.0.0.1. Two deliberate design choices:
 *
 *  - It is a **function argument, not a configuration value**. No environment
 *    variable and no database setting turns it on, so no deployment can be
 *    misconfigured into accepting private addresses; the only way to set it is
 *    to edit code.
 *  - It is an **allow-list of specific hosts**, not a blanket "allow private".
 *    A blanket flag would make the SSRF tests vacuous — a redirect to
 *    169.254.169.254 would pass under the same policy that lets the fixture
 *    server work. With a list, the fixture host is exempt and every other
 *    private address is still refused, so the tests prove what they claim.
 */
export interface UrlPolicy {
  allowedPrivateHosts?: string[];
}

const isExempt = (hostname: string, policy: UrlPolicy): boolean =>
  policy.allowedPrivateHosts?.includes(hostname.toLowerCase()) ?? false;

/** The policy everything uses unless a test says otherwise. */
export const STRICT_URL_POLICY: UrlPolicy = {};

/**
 * Gate 1: syntactic validation of a user-supplied URL.
 *
 * @throws {AppError} VALIDATION_ERROR for anything not a plain, public,
 * credential-free http(s) URL.
 */
export function assertSafePublicUrl(raw: string, policy: UrlPolicy = STRICT_URL_POLICY): URL {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw validationError('A website address is required');
  if (trimmed.length > MAX_URL_LENGTH) throw validationError('That website address is too long');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw validationError('Website URL is not a valid URL', {
      publicMessage:
        "That doesn't look like a web address. Try something like https://yourshop.com",
    });
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw validationError('Website URL must use http or https');
  }
  if (url.username !== '' || url.password !== '') {
    throw validationError('Website URL must not contain credentials');
  }
  // A non-standard port is usually an internal service, and never a public shop.
  if (
    !isExempt(url.hostname, policy) &&
    url.port !== '' &&
    url.port !== '80' &&
    url.port !== '443'
  ) {
    throw validationError(`Website URL must not specify port ${url.port}`, {
      publicMessage: 'Only standard web ports (80 and 443) are allowed.',
    });
  }

  if (!isExempt(url.hostname, policy) && classifyHost(url.hostname) === 'private') {
    throw validationError('Website URL must point at a public host', {
      details: { hostname: url.hostname },
      publicMessage: 'That address points somewhere private, so it cannot be scanned.',
    });
  }

  return url;
}

/**
 * Gate 2: every address DNS gave us must be public.
 *
 * Called immediately before connecting. This is what stops DNS rebinding and a
 * public hostname with a deliberately private A record.
 *
 * @throws {AppError} VALIDATION_ERROR naming the offending address.
 */
export function assertResolvedAddressesArePublic(
  hostname: string,
  addresses: string[],
  policy: UrlPolicy = STRICT_URL_POLICY,
): void {
  if (isExempt(hostname, policy)) return;
  if (addresses.length === 0) {
    throw validationError(`Could not resolve ${hostname}`, {
      publicMessage: 'That website address could not be found.',
    });
  }

  for (const address of addresses) {
    const classification = classifyHost(address);
    if (classification !== 'public') {
      throw validationError(`${hostname} resolves to a non-public address`, {
        details: { hostname, address, classification },
        publicMessage: 'That website resolves to a private address, so it cannot be scanned.',
      });
    }
  }
}

/**
 * Normalises a URL for deduplication.
 *
 * Two URLs that fetch the same page must produce the same key, or the crawler
 * will fetch the same content repeatedly and the page limit will be spent on
 * duplicates. Drops the fragment, sorts the query, lowercases the host, strips
 * a default port and a trailing `index.html`, and removes the tracking
 * parameters that make otherwise-identical URLs look distinct.
 */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  '_ga',
  'igshid',
]);

export function normaliseUrl(input: string | URL, base?: string | URL): string {
  const url = typeof input === 'string' ? new URL(input, base) : new URL(input.toString());

  url.hash = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  url.searchParams.sort();

  url.pathname = url.pathname.replace(/\/index\.(html?|php)$/i, '/').replace(/\/{2,}/g, '/');
  // Keep a single trailing slash meaningful only at the root.
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

/** True when two URLs belong to the same registrable site (ignoring `www.`). */
export function isSameSite(a: string | URL, b: string | URL): boolean {
  const hostOf = (value: string | URL) =>
    (typeof value === 'string' ? new URL(value) : value).hostname
      .toLowerCase()
      .replace(/^www\./, '');
  try {
    return hostOf(a) === hostOf(b);
  } catch {
    return false;
  }
}

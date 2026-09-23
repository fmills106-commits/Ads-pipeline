import { lookup } from 'node:dns/promises';
import { getEnv } from '@/lib/env';
import { AppError } from '@/lib/errors';
import {
  assertResolvedAddressesArePublic,
  assertSafePublicUrl,
  normaliseUrl,
  STRICT_URL_POLICY,
  type UrlPolicy,
} from '@/lib/net-safety';
import {
  FREE_USAGE,
  type FetchedResource,
  type ProviderResult,
  type WebFetchProvider,
  type WebFetchRequest,
} from '../types';

/**
 * The local, free web fetcher.
 *
 * Plain HTTP against public pages. It costs nothing, needs no account, and no
 * paid scraping service is required for the scanner to work.
 *
 * Everything interesting here is a limit or a check, because this is the one
 * component that deliberately sends requests to addresses a stranger chose:
 *
 *  - each URL passes the syntactic gate, then DNS resolution is checked
 *    against the private-address list BEFORE connecting;
 *  - redirects are followed manually, one hop at a time, re-running both
 *    checks on every hop — otherwise a public URL could 302 to
 *    169.254.169.254 and the guard would never see it;
 *  - the response is read in chunks against a byte ceiling, so a multi-gigabyte
 *    body cannot exhaust memory;
 *  - a wall-clock timeout aborts the request;
 *  - only HTML, XML, JSON and plain text are accepted; anything else is
 *    discarded without being read into memory.
 */

const DESCRIPTOR = {
  key: 'webfetch.local',
  capability: 'WEB_FETCH' as const,
  tier: 'LOCAL_FREE' as const,
  label: 'Direct fetch (free)',
  description:
    'Reads public web pages directly from this machine. Costs nothing. Sites that block automated access may need a paid fetching service instead.',
  priority: 0,
  isConfigured: () => true,
};

/** Content types worth parsing. Anything else is not downloaded. */
const ACCEPTABLE_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/xml',
  'application/xml',
  'application/json',
  'application/ld+json',
  'text/plain',
] as const;

const MAX_REDIRECTS = 5;

function isAcceptableType(contentType: string | null): boolean {
  if (contentType === null) return true; // Absent header: read it and see.
  const mime = contentType.split(';')[0]!.trim().toLowerCase();
  return ACCEPTABLE_TYPES.some((accepted) => mime === accepted);
}

/**
 * Reads a body with a hard byte ceiling.
 *
 * `response.text()` would buffer the whole thing first, which is exactly what
 * a hostile or merely enormous page would exploit.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const body = response.body;
  if (!body) return { text: '', bytes: 0, truncated: false };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (bytes + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, Math.max(0, maxBytes - bytes)));
        bytes = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'),
    bytes,
    truncated,
  };
}

/** Resolves a hostname and refuses it if any address is non-public. */
async function assertHostIsSafeToConnect(url: URL, policy: UrlPolicy): Promise<void> {
  if (policy.allowedPrivateHosts?.includes(url.hostname.toLowerCase())) return;
  // An IP literal was already classified by the syntactic gate; no DNS needed.
  const { classifyHost } = await import('@/lib/net-safety');
  if (classifyHost(url.hostname) !== 'not-an-ip') return;

  let addresses: string[];
  try {
    const results = await lookup(url.hostname, { all: true, verbatim: true });
    addresses = results.map((result) => result.address);
  } catch (cause) {
    throw new AppError('CRAWL_ERROR', `Could not resolve ${url.hostname}`, {
      cause,
      publicMessage: 'That website address could not be found.',
    });
  }

  assertResolvedAddressesArePublic(url.hostname, addresses, policy);
}

class LocalWebFetchProvider implements WebFetchProvider {
  readonly descriptor = DESCRIPTOR;

  constructor(private readonly policy: UrlPolicy = STRICT_URL_POLICY) {}

  async fetch(request: WebFetchRequest): Promise<ProviderResult<FetchedResource>> {
    const env = getEnv();
    const timeoutMs = request.timeoutMs ?? env.CRAWLER_TIMEOUT_MS;
    const maxBytes = request.maxBytes ?? env.CRAWLER_MAX_BYTES;

    let current = assertSafePublicUrl(request.url, this.policy);
    const redirectChain: string[] = [];
    let totalBytes = 0;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // Re-checked on EVERY hop. A 302 to a private address is the whole
      // reason redirects are followed by hand rather than by fetch().
      await assertHostIsSafeToConnect(current, this.policy);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let response: Response;
      try {
        response = await globalThis.fetch(current, {
          method: request.method ?? 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': env.CRAWLER_USER_AGENT,
            accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.1',
            'accept-language': 'en',
          },
        });
      } catch (cause) {
        clearTimeout(timer);
        const aborted = controller.signal.aborted;
        throw new AppError(
          aborted ? 'PROVIDER_TIMEOUT' : 'CRAWL_ERROR',
          `Fetch failed: ${current}`,
          {
            cause,
            details: { url: current.toString(), timeoutMs },
            retryable: true,
            publicMessage: aborted
              ? 'That page took too long to respond.'
              : 'That page could not be read.',
          },
        );
      } finally {
        clearTimeout(timer);
      }

      const status = response.status;

      // --- redirects ------------------------------------------------------
      if (status >= 300 && status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);

        if (!location) {
          throw new AppError('CRAWL_ERROR', `Redirect without a Location header: ${current}`, {
            details: { url: current.toString(), status },
          });
        }
        if (hop === MAX_REDIRECTS) {
          throw new AppError('CRAWL_ERROR', `Too many redirects from ${request.url}`, {
            details: { chain: redirectChain },
            publicMessage: 'That page redirected too many times.',
          });
        }

        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new AppError('CRAWL_ERROR', `Redirect to an invalid URL: ${location}`);
        }
        // Full syntactic re-validation, so scheme/port/credential rules and the
        // private-address list apply to the target as strictly as to the origin.
        current = assertSafePublicUrl(next.toString(), this.policy);
        redirectChain.push(current.toString());
        continue;
      }

      // --- content type ---------------------------------------------------
      const contentType = response.headers.get('content-type');
      if (!isAcceptableType(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        return {
          value: {
            url: normaliseUrl(current),
            finalUrl: normaliseUrl(current),
            status,
            contentType,
            body: '',
            bytes: 0,
            truncated: false,
            redirectChain,
            skippedReason: 'unsupported-content-type',
          },
          usage: FREE_USAGE(0, 'bytes'),
        };
      }

      // Trust the declared length when it is already over the ceiling, rather
      // than streaming a body we know will be rejected.
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel().catch(() => undefined);
        return {
          value: {
            url: normaliseUrl(current),
            finalUrl: normaliseUrl(current),
            status,
            contentType,
            body: '',
            bytes: 0,
            truncated: true,
            redirectChain,
            skippedReason: 'too-large',
          },
          usage: FREE_USAGE(0, 'bytes'),
        };
      }

      const { text, bytes, truncated } = await readCapped(response, maxBytes);
      totalBytes += bytes;

      return {
        value: {
          url: normaliseUrl(request.url),
          finalUrl: normaliseUrl(current),
          status,
          contentType,
          body: text,
          bytes,
          truncated,
          redirectChain,
        },
        usage: FREE_USAGE(totalBytes, 'bytes'),
      };
    }

    // Unreachable: the loop returns or throws.
    throw new AppError('CRAWL_ERROR', `Fetch loop exhausted for ${request.url}`);
  }
}

/**
 * `policy` is for tests only — see `UrlPolicy`. The registry always
 * constructs this with no argument, so production gets the strict policy.
 */
export const createLocalWebFetchProvider = (policy?: UrlPolicy): WebFetchProvider =>
  new LocalWebFetchProvider(policy);
export const localWebFetchDescriptor = DESCRIPTOR;

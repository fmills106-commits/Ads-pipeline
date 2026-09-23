import { getEnv } from '@/lib/env';
import { toAppError } from '@/lib/errors';
import { logger, type Logger } from '@/lib/logger';
import {
  assertSafePublicUrl,
  isSameSite,
  normaliseUrl,
  STRICT_URL_POLICY,
  type UrlPolicy,
} from '@/lib/net-safety';
import type { FetchedResource, WebFetchProvider } from '@/server/providers/types';
import { extractFromHtml, type PageExtraction } from './html';
import {
  crawlDelayMs,
  isAllowed,
  looksLikeRobotsTxt,
  parseRobotsTxt,
  type RobotsTxt,
} from './robots';
import { parseSitemap, prioritiseEntries, wellKnownSitemapUrls } from './sitemap';

/**
 * The crawl loop.
 *
 * Bounded on every axis that could otherwise run away: pages, bytes, wall
 * clock, and requests per second against one host. A scan that hits a limit
 * reports PARTIAL and says which limit — it does not silently return less than
 * it found.
 *
 * Politeness is not decoration here. This code fetches other people's servers
 * on a merchant's behalf, so it identifies itself, obeys robots.txt, honours a
 * declared crawl-delay, and never runs two requests concurrently against the
 * same host.
 */

export interface CrawlLimits {
  maxPages: number;
  maxBytes: number;
  maxDurationMs: number;
  minDelayMs: number;
  perPageTimeoutMs: number;
  maxPageBytes: number;
}

export function defaultCrawlLimits(): CrawlLimits {
  const env = getEnv();
  return {
    maxPages: env.CRAWLER_MAX_PAGES,
    // A whole-scan byte ceiling on top of the per-page one.
    maxBytes: env.CRAWLER_MAX_BYTES * 20,
    maxDurationMs: 4 * 60 * 1000,
    minDelayMs: env.CRAWLER_MIN_DELAY_MS,
    perPageTimeoutMs: env.CRAWLER_TIMEOUT_MS,
    maxPageBytes: env.CRAWLER_MAX_BYTES,
  };
}

export interface CrawledPage {
  url: string;
  finalUrl: string;
  status: number;
  bytes: number;
  extraction: PageExtraction;
}

export interface CrawlWarning {
  url: string;
  reason: string;
  detail?: string;
}

/**
 * Why the crawl stopped.
 *
 * `unreachable` is the one that matters for honesty: a crawl that ran to the
 * end of its frontier without reading a single page has *not* completed, even
 * though nothing went wrong procedurally. Reporting that as success would show
 * the owner an empty Website page implying we looked and their site had
 * nothing on it. The reason it could not be read is in `warnings`.
 */
export type StopReason =
  'completed' | 'unreachable' | 'page-limit' | 'byte-limit' | 'time-limit' | 'cancelled';

export interface CrawlResult {
  rootUrl: string;
  resolvedRootUrl: string;
  robotsTxt: string | null;
  sitemapUrls: string[];
  pages: CrawledPage[];
  warnings: CrawlWarning[];
  stopReason: StopReason;
  pagesFetched: number;
  pagesSkipped: number;
  bytesFetched: number;
  /** Total fetches made, including robots.txt and sitemaps. */
  requestCount: number;
}

export interface CrawlOptions {
  startUrl: string;
  fetcher: WebFetchProvider;
  limits?: Partial<CrawlLimits>;
  /** Checked between pages so a pause or cancel takes effect promptly. */
  shouldStop?: () => boolean | Promise<boolean>;
  /** Injected in tests to avoid real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Test-only; see `UrlPolicy`. Production always uses the strict policy. */
  urlPolicy?: UrlPolicy;
  log?: Logger;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Priority for the crawl frontier: lower runs sooner. */
function frontierPriority(url: string): number {
  let path = '/';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    /* default */
  }
  if (path === '/' || path === '') return 0;
  if (/\/(?:products?|item)\//.test(path)) return 1;
  if (/\/(?:collections?|categor|shop|store)/.test(path)) return 2;
  if (/\/(?:about|contact|faq|shipping|returns|policies|policy|terms)/.test(path)) return 3;
  if (/\/(?:blogs?|news|articles?|posts?|tag|author)\//.test(path)) return 6;
  return 4;
}

export async function crawlWebsite(options: CrawlOptions): Promise<CrawlResult> {
  const limits = { ...defaultCrawlLimits(), ...options.limits };
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? logger().child({ component: 'crawler' });

  const policy = options.urlPolicy ?? STRICT_URL_POLICY;
  const start = assertSafePublicUrl(options.startUrl, policy);
  const origin = start.origin;
  const rootUrl = normaliseUrl(start);

  const pages: CrawledPage[] = [];
  const warnings: CrawlWarning[] = [];
  const seen = new Set<string>([rootUrl]);
  const frontier: string[] = [rootUrl];

  let bytesFetched = 0;
  let pagesSkipped = 0;
  let requestCount = 0;
  let stopReason: StopReason = 'completed';
  let resolvedRootUrl = rootUrl;

  const startedAt = Date.now();
  let lastRequestAt = 0;

  /** One fetch, rate-limited and counted. Returns null on failure. */
  const fetchOnce = async (url: string): Promise<FetchedResource | null> => {
    const sinceLast = Date.now() - lastRequestAt;
    if (lastRequestAt !== 0 && sinceLast < politeDelayMs) {
      await sleep(politeDelayMs - sinceLast);
    }
    lastRequestAt = Date.now();
    requestCount += 1;

    try {
      const result = await options.fetcher.fetch({
        url,
        timeoutMs: limits.perPageTimeoutMs,
        maxBytes: limits.maxPageBytes,
      });
      return result.value;
    } catch (thrown) {
      const error = toAppError(thrown);
      warnings.push({ url, reason: error.code, detail: error.publicMessage });
      log.debug('Fetch failed during crawl', { url, code: error.code });
      return null;
    }
  };

  // --- robots.txt --------------------------------------------------------
  let politeDelayMs = limits.minDelayMs;
  let robots: RobotsTxt = { groups: [], sitemaps: [] };
  let robotsTxt: string | null = null;

  const userAgent = getEnv().CRAWLER_USER_AGENT;
  const robotsResource = await fetchOnce(`${origin}/robots.txt`);

  if (robotsResource && robotsResource.status === 200 && robotsResource.body !== '') {
    if (looksLikeRobotsTxt(robotsResource.body, robotsResource.contentType)) {
      robotsTxt = robotsResource.body.slice(0, 100_000);
      robots = parseRobotsTxt(robotsTxt);
      bytesFetched += robotsResource.bytes;

      const declared = crawlDelayMs(robots, userAgent);
      // Honour a slower delay than ours, but never a faster one.
      if (declared !== null) politeDelayMs = Math.max(politeDelayMs, Math.min(declared, 10_000));
    } else {
      warnings.push({ url: `${origin}/robots.txt`, reason: 'robots-not-plain-text' });
    }
  }

  // --- sitemaps ----------------------------------------------------------
  const sitemapCandidates =
    robots.sitemaps.length > 0 ? robots.sitemaps : wellKnownSitemapUrls(origin);
  const sitemapUrls: string[] = [];
  const sitemapQueue = [...sitemapCandidates.slice(0, 5)];
  const visitedSitemaps = new Set<string>();
  let sitemapEntriesFound = 0;

  while (sitemapQueue.length > 0 && sitemapEntriesFound < limits.maxPages * 3) {
    const candidate = sitemapQueue.shift()!;
    if (visitedSitemaps.has(candidate) || visitedSitemaps.size >= 10) continue;
    visitedSitemaps.add(candidate);

    // A sitemap URL comes from a file on the site, so it is untrusted input
    // and must pass the same gate as anything else.
    let safe: string;
    try {
      safe = assertSafePublicUrl(candidate, policy).toString();
    } catch {
      continue;
    }
    if (!isSameSite(safe, origin)) continue;

    const resource = await fetchOnce(safe);
    if (!resource || resource.status !== 200 || resource.body === '') continue;
    bytesFetched += resource.bytes;

    const parsed = parseSitemap(resource.body, origin);
    if (parsed.kind === 'sitemapindex') {
      sitemapQueue.push(...parsed.sitemaps.slice(0, 10));
      sitemapUrls.push(safe);
      continue;
    }
    if (parsed.entries.length === 0) continue;

    sitemapUrls.push(safe);
    sitemapEntriesFound += parsed.entries.length;

    for (const entry of prioritiseEntries(parsed.entries)) {
      if (seen.has(entry.url)) continue;
      seen.add(entry.url);
      frontier.push(entry.url);
    }
  }

  // --- the crawl ---------------------------------------------------------
  while (frontier.length > 0) {
    if (pages.length >= limits.maxPages) {
      stopReason = 'page-limit';
      break;
    }
    if (bytesFetched >= limits.maxBytes) {
      stopReason = 'byte-limit';
      break;
    }
    if (Date.now() - startedAt >= limits.maxDurationMs) {
      stopReason = 'time-limit';
      break;
    }
    if (options.shouldStop && (await options.shouldStop())) {
      stopReason = 'cancelled';
      break;
    }

    // The page the user actually asked for is always fetched first. Sorting
    // the frontier before the first fetch would let a sitemap entry displace
    // the start URL, so a scan pointed at one product page could come back
    // having read the homepage instead.
    if (pages.length > 0) {
      // Cheap priority queue: the frontier is small enough that sorting on
      // each iteration is far cheaper than maintaining a heap.
      frontier.sort((a, b) => frontierPriority(a) - frontierPriority(b));
    }
    const url = frontier.shift()!;

    let safeUrl: string;
    try {
      safeUrl = assertSafePublicUrl(url, policy).toString();
    } catch {
      pagesSkipped += 1;
      warnings.push({ url, reason: 'unsafe-url' });
      continue;
    }

    let pathname = '/';
    try {
      pathname = new URL(safeUrl).pathname;
    } catch {
      /* default */
    }
    if (!isAllowed(robots, userAgent, pathname)) {
      pagesSkipped += 1;
      warnings.push({ url: safeUrl, reason: 'robots-disallowed' });
      continue;
    }

    const resource = await fetchOnce(safeUrl);
    if (!resource) {
      pagesSkipped += 1;
      continue;
    }

    if (resource.skippedReason) {
      pagesSkipped += 1;
      warnings.push({ url: safeUrl, reason: resource.skippedReason });
      continue;
    }
    if (resource.status !== 200) {
      pagesSkipped += 1;
      warnings.push({ url: safeUrl, reason: `http-${resource.status}` });
      continue;
    }
    if (!/html|xml/i.test(resource.contentType ?? 'text/html')) {
      pagesSkipped += 1;
      warnings.push({ url: safeUrl, reason: 'not-html' });
      continue;
    }

    bytesFetched += resource.bytes;

    // A redirect to a different URL means the canonical location differs; if
    // we already have that one, this is a duplicate.
    if (resource.finalUrl !== resource.url && seen.has(resource.finalUrl) && pages.length > 0) {
      pagesSkipped += 1;
      continue;
    }
    seen.add(resource.finalUrl);

    const extraction = extractFromHtml(resource.body, resource.finalUrl);

    // The first page fetched establishes where the site actually lives.
    if (pages.length === 0) resolvedRootUrl = resource.finalUrl;

    // A canonical URL pointing elsewhere marks this as a duplicate view.
    if (extraction.canonicalUrl !== null && isSameSite(extraction.canonicalUrl, origin)) {
      const canonical = normaliseUrl(extraction.canonicalUrl);
      if (canonical !== resource.finalUrl && seen.has(canonical)) {
        pagesSkipped += 1;
        continue;
      }
      seen.add(canonical);
    }

    pages.push({
      url: resource.url,
      finalUrl: resource.finalUrl,
      status: resource.status,
      bytes: resource.bytes,
      extraction,
    });

    if (extraction.injectionSignals.length > 0) {
      // Recorded, not acted on: the structural containment in untrusted.ts is
      // the actual defence. This is so a human can see it happened.
      log.warn('Page contains text resembling an AI instruction', {
        url: resource.finalUrl,
        signals: extraction.injectionSignals,
      });
      warnings.push({
        url: resource.finalUrl,
        reason: 'instruction-like-text',
        detail: extraction.injectionSignals.join(', '),
      });
    }

    for (const link of extraction.links) {
      if (seen.size >= limits.maxPages * 6) break;
      if (seen.has(link)) continue;
      if (!isSameSite(link, origin)) continue;
      seen.add(link);
      frontier.push(link);
    }
  }

  // Nothing was read. Whatever the procedural reason, this is not a completed
  // scan, and the caller must not present it as one. A cancel is left as-is:
  // the owner stopped it, which is a different story to tell them.
  if (pages.length === 0 && stopReason !== 'cancelled') {
    stopReason = 'unreachable';
  }

  log.info('Crawl finished', {
    rootUrl,
    pages: pages.length,
    skipped: pagesSkipped,
    bytes: bytesFetched,
    requests: requestCount,
    stopReason,
    durationMs: Date.now() - startedAt,
  });

  return {
    rootUrl,
    resolvedRootUrl,
    robotsTxt,
    sitemapUrls,
    pages,
    warnings: warnings.slice(0, 200),
    stopReason,
    pagesFetched: pages.length,
    pagesSkipped,
    bytesFetched,
    requestCount,
  };
}

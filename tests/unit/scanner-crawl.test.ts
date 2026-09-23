import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawlWebsite, type CrawlResult } from '@/server/scanner/crawler';
import { createLocalWebFetchProvider } from '@/server/providers/local/web-fetch';
import type { WebFetchProvider } from '@/server/providers/types';
import { AppError } from '@/lib/errors';
import type { UrlPolicy } from '@/lib/net-safety';
import { startFixtureSite, type FixtureSite } from '../helpers/fixture-site';

/**
 * The crawler, against a real HTTP server on a real socket.
 *
 * Mocking `fetch` here would test the parts that are already unit-tested and
 * skip the parts most likely to break: redirect handling, content types,
 * status codes and the SSRF checks that run per hop.
 */

let site: FixtureSite;
/**
 * The fixture is on loopback, which the SSRF guard blocks by design. The host
 * is exempted by name — NOT by a blanket "allow private" flag — so every other
 * private address stays refused and the SSRF assertions below mean something.
 */
let policy: UrlPolicy;
let crawl: CrawlResult;

beforeAll(async () => {
  site = await startFixtureSite();
  policy = { allowedPrivateHosts: ['127.0.0.1'] };

  crawl = await crawlWebsite({
    startUrl: site.origin,
    fetcher: createLocalWebFetchProvider(policy),
    urlPolicy: policy,
    // No waiting in tests; politeness is asserted separately.
    sleep: async () => undefined,
    limits: { minDelayMs: 0, maxPages: 50 },
  });
}, 60_000);

afterAll(async () => {
  await site.close();
});

describe('crawling a site end to end', () => {
  it('completes rather than hitting a limit', () => {
    expect(crawl.stopReason).toBe('completed');
  });

  it('fetches and respects robots.txt', () => {
    expect(crawl.robotsTxt).toContain('Disallow: /admin');
    expect(site.requests).toContain('/robots.txt');
  });

  it('skips a path robots.txt disallows', () => {
    const fetched = crawl.pages.map((page) => new URL(page.finalUrl).pathname);
    expect(fetched).not.toContain('/admin');
    expect(crawl.warnings.some((warning) => warning.reason === 'robots-disallowed')).toBe(true);
  });

  it('follows a longer Allow that overrides the Disallow', () => {
    // robots.txt disallows /admin but allows /admin/public.
    expect(site.requests).toContain('/admin/public');
  });

  it('discovers and uses the sitemap', () => {
    expect(crawl.sitemapUrls.some((url) => url.endsWith('/sitemap.xml'))).toBe(true);
  });

  it('ignores a sitemap entry pointing at another site', () => {
    expect(crawl.pages.some((page) => page.finalUrl.includes('somewhere-else'))).toBe(false);
  });

  it('finds every product page', () => {
    const products = crawl.pages.filter((page) => page.extraction.product !== null);
    const names = products.map((page) => String(page.extraction.product?.name?.value));

    expect(names).toContain('Sourdough Starter');
    expect(names).toContain('Rye Flour 1kg');
    expect(names).toContain('Banneton Proofing Basket');
  });

  it('extracts prices correctly across all three markup styles', () => {
    const byName = new Map(
      crawl.pages
        .filter((page) => page.extraction.product)
        .map((page) => [String(page.extraction.product!.name?.value), page.extraction.product!]),
    );

    expect(byName.get('Sourdough Starter')?.priceCents?.value).toBe(1999); // JSON-LD
    expect(byName.get('Rye Flour 1kg')?.priceCents?.value).toBe(850); // OpenGraph, "8,50" EUR
    expect(byName.get('Banneton Proofing Basket')?.priceCents?.value).toBe(3200); // microdata
  });

  it('reads availability, including out of stock', () => {
    const banneton = crawl.pages.find(
      (page) => page.extraction.product?.name?.value === 'Banneton Proofing Basket',
    );
    expect(banneton?.extraction.product?.availability?.value).toBe('OUT_OF_STOCK');
  });

  it('extracts business contact details from structured data', () => {
    const home = crawl.pages.find((page) => new URL(page.finalUrl).pathname === '/');
    expect(home?.extraction.business.email?.value).toBe('hello@alpinebakery.example');
    expect(home?.extraction.business.name?.value).toBe('Alpine Bakery Supply');
  });

  it('classifies pages by type', () => {
    const types = new Set(crawl.pages.map((page) => page.extraction.pageType));
    expect(types).toContain('HOME');
    expect(types).toContain('PRODUCT');
    expect(types).toContain('ABOUT');
    expect(types).toContain('SHIPPING');
  });

  it('never even requests a binary file linked from a page', () => {
    // Cheaper than fetching and rejecting it: asset extensions are filtered
    // out of the frontier, so the byte budget is never spent on a PDF.
    expect(site.requests).not.toContain('/catalogue.pdf');
    expect(crawl.pages.some((page) => page.finalUrl.endsWith('.pdf'))).toBe(false);
  });

  it('records every page it did fetch exactly once', () => {
    const urls = crawl.pages.map((page) => page.finalUrl);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it('never requests the same path twice', () => {
    // Deduplication is what keeps a bounded page budget productive.
    const duplicates = site.requests.filter((path, index) => site.requests.indexOf(path) !== index);
    expect(duplicates).toEqual([]);
  });

  it('flags a page whose text resembles an AI instruction', async () => {
    const result = await crawlWebsite({
      startUrl: `${site.origin}/products/suspicious`,
      fetcher: createLocalWebFetchProvider(policy),
      urlPolicy: policy,
      sleep: async () => undefined,
      limits: { minDelayMs: 0, maxPages: 1 },
    });

    const page = result.pages[0];
    expect(page?.extraction.injectionSignals).toContain('ignore-instructions');
    // Flagged, but the content is still captured: the defence is structural
    // separation, not deletion.
    expect(page?.extraction.text).toContain('Ignore all previous instructions');
  });
});

describe('SSRF defence during a crawl', () => {
  it('refuses a redirect to the cloud metadata endpoint', async () => {
    // 127.0.0.1 is exempt for the fixture; 169.254.169.254 is not, so this
    // proves the per-hop re-validation rather than the exemption.
    const fetcher = createLocalWebFetchProvider(policy);
    await expect(fetcher.fetch({ url: `${site.origin}/redirect-to-metadata` })).rejects.toThrow(
      /public host/,
    );
  });

  it('refuses a redirect to a decimal-encoded private address', async () => {
    // http://167772161/ is 10.0.0.1. Node normalises the decimal form before
    // the guard sees it, and the guard must still recognise it as private.
    const fetcher = createLocalWebFetchProvider(policy);
    await expect(
      fetcher.fetch({ url: `${site.origin}/redirect-to-decimal-private` }),
    ).rejects.toThrow(/public host/);
  });

  it('refuses the fixture host under the default strict policy', async () => {
    // Confirms the exemption above is doing real work and is not the default.
    const strict = createLocalWebFetchProvider();
    await expect(strict.fetch({ url: site.origin })).rejects.toThrow();
  });
});

describe('fetcher limits', () => {
  it('follows an ordinary redirect and reports the chain', async () => {
    const fetcher = createLocalWebFetchProvider(policy);
    const result = await fetcher.fetch({ url: `${site.origin}/old-product` });

    expect(result.value.status).toBe(200);
    expect(result.value.finalUrl).toContain('/products/sourdough-starter');
    expect(result.value.redirectChain).toHaveLength(1);
  });

  it('reports a 404 rather than throwing', async () => {
    const fetcher = createLocalWebFetchProvider(policy);
    const result = await fetcher.fetch({ url: `${site.origin}/gone` });
    expect(result.value.status).toBe(404);
  });

  it('refuses to read a body past the byte ceiling', async () => {
    const fetcher = createLocalWebFetchProvider(policy);
    const result = await fetcher.fetch({ url: site.origin, maxBytes: 50 });

    expect(result.value.bytes).toBeLessThanOrEqual(50);
    expect(result.value.truncated).toBe(true);
  });

  it('declines a non-HTML content type without downloading it', async () => {
    const fetcher = createLocalWebFetchProvider(policy);
    const result = await fetcher.fetch({ url: `${site.origin}/catalogue.pdf` });

    expect(result.value.skippedReason).toBe('unsupported-content-type');
    expect(result.value.bytes).toBe(0);
  });

  it('reports zero cost for every fetch', async () => {
    const fetcher = createLocalWebFetchProvider(policy);
    const result = await fetcher.fetch({ url: site.origin });

    expect(result.usage.estimatedCostCents).toBe(0);
    expect(result.usage.actualCostCents).toBe(0);
  });
});

describe('crawl limits', () => {
  it('stops at the page limit and says so', async () => {
    const result = await crawlWebsite({
      startUrl: site.origin,
      fetcher: createLocalWebFetchProvider(policy),
      urlPolicy: policy,
      sleep: async () => undefined,
      limits: { minDelayMs: 0, maxPages: 2 },
    });

    expect(result.pages).toHaveLength(2);
    expect(result.stopReason).toBe('page-limit');
  });

  it('stops when asked to', async () => {
    const result = await crawlWebsite({
      startUrl: site.origin,
      fetcher: createLocalWebFetchProvider(policy),
      urlPolicy: policy,
      sleep: async () => undefined,
      limits: { minDelayMs: 0 },
      shouldStop: () => true,
    });

    expect(result.stopReason).toBe('cancelled');
    expect(result.pages).toHaveLength(0);
  });

  /**
   * These cover a bug found by the end-to-end run: the crawl loop finished
   * normally having fetched nothing, and reported `completed`. The scan then
   * stored as COMPLETED, which showed the owner an empty Website page implying
   * their site had no products on it. A crawl that read nothing is not a
   * completed crawl.
   */
  describe('a crawl that reads nothing', () => {
    /** Always throws, as the fetcher does for a refused or unresolvable host. */
    const refusingFetcher = (message: string): WebFetchProvider => ({
      descriptor: {
        key: 'webfetch.stub',
        capability: 'WEB_FETCH',
        tier: 'LOCAL_FREE',
        label: 'stub',
        description: 'test double',
        priority: 0,
        isConfigured: () => true,
      },
      fetch: async () => {
        throw new AppError('CRAWL_ERROR', message, { publicMessage: message });
      },
    });

    const crawlNothing = async (fetcher: WebFetchProvider): Promise<CrawlResult> =>
      crawlWebsite({
        // A public hostname, so the syntactic gate passes and the failure
        // happens where a real refusal happens: in the fetcher.
        startUrl: 'https://shop.example.com/',
        fetcher,
        sleep: async () => undefined,
        limits: { minDelayMs: 0 },
      });

    it('reports unreachable rather than completed', async () => {
      const result = await crawlNothing(refusingFetcher('nope'));

      expect(result.pagesFetched).toBe(0);
      expect(result.stopReason).toBe('unreachable');
    });

    it('keeps the reason so the owner can be told', async () => {
      const result = await crawlNothing(
        refusingFetcher('That website resolves to a private address, so it cannot be scanned.'),
      );

      expect(result.warnings.some((warning) => warning.detail?.includes('private address'))).toBe(
        true,
      );
    });

    it('still reports a cancel as cancelled, not unreachable', async () => {
      // The owner stopping a scan is a different story from a site we could
      // not read, and must not be reported as a failure.
      const result = await crawlWebsite({
        startUrl: site.origin,
        fetcher: createLocalWebFetchProvider(policy),
        urlPolicy: policy,
        sleep: async () => undefined,
        limits: { minDelayMs: 0 },
        shouldStop: () => true,
      });

      expect(result.pagesFetched).toBe(0);
      expect(result.stopReason).toBe('cancelled');
    });
  });

  it('waits between requests when a delay is configured', async () => {
    const waits: number[] = [];
    await crawlWebsite({
      startUrl: site.origin,
      fetcher: createLocalWebFetchProvider(policy),
      urlPolicy: policy,
      sleep: async (ms) => {
        waits.push(ms);
      },
      limits: { minDelayMs: 500, maxPages: 3 },
    });

    // Politeness is not optional when fetching someone else's server.
    expect(waits.length).toBeGreaterThan(0);
    expect(Math.max(...waits)).toBeLessThanOrEqual(500);
  });
});

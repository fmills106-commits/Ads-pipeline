import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawlWebsite, type CrawlResult } from '@/server/scanner/crawler';
import { createLocalWebFetchProvider } from '@/server/providers/local/web-fetch';
import type { WebFetchProvider } from '@/server/providers/types';
import { AppError } from '@/lib/errors';
import type { UrlPolicy } from '@/lib/net-safety';
import { startFixtureSite, type FixtureSite } from '../helpers/fixture-site';
import { describeHttpStatus, pausedSince } from '@/server/scanner/job';
import { getEnv } from '@/lib/env';

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
    const products = crawl.pages.filter((page) => page.extraction.products.length > 0);
    const names = products.map((page) => String(page.extraction.products[0]?.name?.value));

    expect(names).toContain('Sourdough Starter');
    expect(names).toContain('Rye Flour 1kg');
    expect(names).toContain('Banneton Proofing Basket');
  });

  it('extracts prices correctly across all three markup styles', () => {
    const byName = new Map(
      crawl.pages
        .filter((page) => page.extraction.products.length > 0)
        .map((page) => [
          String(page.extraction.products[0]!.name?.value),
          page.extraction.products[0]!,
        ]),
    );

    expect(byName.get('Sourdough Starter')?.priceCents?.value).toBe(1999); // JSON-LD
    expect(byName.get('Rye Flour 1kg')?.priceCents?.value).toBe(850); // OpenGraph, "8,50" EUR
    expect(byName.get('Banneton Proofing Basket')?.priceCents?.value).toBe(3200); // microdata
  });

  it('reads availability, including out of stock', () => {
    const banneton = crawl.pages.find(
      (page) => page.extraction.products[0]?.name?.value === 'Banneton Proofing Basket',
    );
    expect(banneton?.extraction.products[0]?.availability?.value).toBe('OUT_OF_STOCK');
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

/**
 * The crawl over the fixture pages modelled on the first real shops. These
 * exercise the whole path — socket, robots, extraction — rather than calling
 * the extractor directly.
 */
describe('product discovery across awkward real-world pages', () => {
  const pageFor = (path: string) => crawl.pages.find((page) => page.finalUrl.endsWith(path));

  describe('a shop whose products all live on one page', () => {
    /*
     * The fixture's /packs page, reached through the sitemap rather than the
     * nav. This is the shape that returned nothing at all: three pack sizes in
     * one section, no structured data, and the extractor stopping at one product
     * per page.
     */
    const packsPage = () => pageFor('/packs');

    it('finds every pack, not one of them', () => {
      expect(packsPage()?.extraction.products.map((p) => p.name?.value)).toEqual([
        'Single',
        '3-Pack',
        'Full Case',
      ]);
    });

    it('prices each pack from its own card', () => {
      expect(packsPage()?.extraction.products.map((p) => p.priceCents?.value)).toEqual([
        1500, 3900, 13200,
      ]);
    });

    it('does not turn the cart total into a free product', () => {
      const prices = packsPage()?.extraction.products.map((p) => p.priceCents?.value) ?? [];
      expect(prices).not.toContain(0);
    });
  });

  it('finds no product on a category listing', () => {
    const listing = pageFor('/collections/flours');
    expect(listing?.extraction.products).toHaveLength(0);
    expect(listing?.extraction.pageType).toBe('COLLECTION');
  });

  it('finds a product on a page whose only price is a labelled element', () => {
    const plain = pageFor('/shop/linen-couche');

    expect(plain?.extraction.products[0]?.name?.value).toBe('Linen couche');
    expect(plain?.extraction.products[0]?.priceCents?.value).toBe(1850);
    expect(plain?.extraction.products[0]?.currency?.value).toBe('GBP');
  });

  it('reads an itemprop name from the link text', () => {
    const linked = pageFor('/products/linked-name');

    expect(linked?.extraction.products[0]?.name?.value).toBe('Proving cloth');
    expect(linked?.extraction.products[0]?.priceCents?.value).toBe(1200);
  });

  it('does not read product data out of a non-Product itemscope', () => {
    const plans = pageFor('/plans');
    expect(plans?.extraction.products[0]?.name?.method).not.toBe('MICRODATA');
  });

  it('never names a product after a page heading that is a category', () => {
    const names = crawl.pages
      .map((page) => page.extraction.products[0]?.name?.value)
      .filter((name): name is string => typeof name === 'string');

    expect(names).not.toContain('Flours');
    expect(names).not.toContain('Alpine Bakery Supply');
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

describe('a pause during a crawl, versus one already in force', () => {
  /*
   * The rule the crawler stops on, tested directly because it cannot be
   * reached through the job: `crawlWebsite` validates its start URL against
   * the strict policy, which has no test escape hatch on purpose, so the job
   * can only be exercised against hosts that never resolve.
   *
   * Both halves matter. Reading a site while advertising is already paused is
   * allowed — it spends nothing — and a crawl that stopped on any pause at all
   * cancelled itself before its first page, which looked exactly like the
   * button not working. Pressing pause during a crawl must still stop it.
   */
  const startedAt = new Date('2026-09-26T12:00:00.000Z').getTime();

  it('does not stop for a pause that was already in force', () => {
    const before = new Date(startedAt - 60_000);
    expect(pausedSince(before, startedAt)).toBe(false);
  });

  it('stops for a pause pressed after the crawl began', () => {
    const during = new Date(startedAt + 5_000);
    expect(pausedSince(during, startedAt)).toBe(true);
  });

  it('does not stop when nothing is paused', () => {
    expect(pausedSince(null, startedAt)).toBe(false);
  });
});

describe('what an owner is told when their site refuses us', () => {
  /*
   * A real site behind Cloudflare answered 403 to the crawl, and the message
   * was "The website answered with an error (403)." Accurate, and useless: it
   * described an HTTP status to somebody who does not read HTTP statuses, and
   * offered nothing to do about it. On a site the owner controls, a 403 is
   * nearly always bot protection in front of it — a setting they can change,
   * once they know that is what they are looking at.
   */
  it('explains a refusal and names the visitor to allow', () => {
    const message = describeHttpStatus('403');

    expect(message).toMatch(/firewall|bot protection/i);
    expect(message).toContain(getEnv().CRAWLER_USER_AGENT);
    // Not just the number and a full stop.
    expect(message.length).toBeGreaterThan(80);
  });

  it('treats 401 the same way', () => {
    expect(describeHttpStatus('401')).toMatch(/bot protection/i);
  });

  it('does not blame the owner for the site being down', () => {
    const message = describeHttpStatus('503');
    expect(message).toMatch(/at the site's end, not ours/);
    expect(message).not.toMatch(/firewall/i);
  });

  it('points a 404 at the address', () => {
    expect(describeHttpStatus('404')).toMatch(/Check the address/);
  });

  it('still says something useful for a status it has no advice for', () => {
    expect(describeHttpStatus('418')).toContain('418');
  });
});

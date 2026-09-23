import { parse } from 'node-html-parser';
import { isSameSite, normaliseUrl } from '@/lib/net-safety';

/**
 * sitemap.xml parsing.
 *
 * A sitemap is the cheapest possible way to find a shop's product pages: the
 * merchant has already listed them. Reading it first means a 200-page budget
 * is spent on product pages rather than on pagination and tag archives.
 *
 * Handles both shapes:
 *  - `<urlset>` — a list of pages
 *  - `<sitemapindex>` — a list of further sitemaps, which is what large
 *    Shopify and WooCommerce stores serve
 *
 * XML is parsed with the same tolerant HTML parser used elsewhere rather than
 * a strict XML parser, because real sitemaps are frequently malformed and a
 * strict parse would throw away a usable list over one bad character. No
 * external entities are resolved, so XXE is not reachable.
 */

export interface SitemapEntry {
  url: string;
  lastModified?: Date;
  /** 0..1 as declared by the sitemap. Advisory only. */
  priority?: number;
}

export interface ParsedSitemap {
  kind: 'urlset' | 'sitemapindex' | 'unknown';
  entries: SitemapEntry[];
  /** Nested sitemap URLs, when `kind` is `sitemapindex`. */
  sitemaps: string[];
}

const MAX_ENTRIES = 5_000;

export function parseSitemap(xml: string, baseUrl: string): ParsedSitemap {
  const root = parse(xml, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: { script: false, noscript: false, style: false, pre: false },
  });

  const sitemapNodes = root.querySelectorAll('sitemap');
  const urlNodes = root.querySelectorAll('url');

  // An index and a urlset are distinguished by which element carries the locs.
  if (sitemapNodes.length > 0 && urlNodes.length === 0) {
    const sitemaps: string[] = [];
    for (const node of sitemapNodes.slice(0, MAX_ENTRIES)) {
      const loc = node.querySelector('loc')?.text?.trim();
      const resolved = safeNormalise(loc, baseUrl);
      if (resolved) sitemaps.push(resolved);
    }
    return { kind: 'sitemapindex', entries: [], sitemaps };
  }

  const entries: SitemapEntry[] = [];
  for (const node of urlNodes.slice(0, MAX_ENTRIES)) {
    const loc = node.querySelector('loc')?.text?.trim();
    const resolved = safeNormalise(loc, baseUrl);
    if (!resolved) continue;

    const entry: SitemapEntry = { url: resolved };

    const lastmod = node.querySelector('lastmod')?.text?.trim();
    if (lastmod) {
      const parsed = new Date(lastmod);
      if (!Number.isNaN(parsed.getTime())) entry.lastModified = parsed;
    }

    const priority = Number(node.querySelector('priority')?.text?.trim());
    if (Number.isFinite(priority) && priority >= 0 && priority <= 1) entry.priority = priority;

    entries.push(entry);
  }

  if (entries.length > 0) return { kind: 'urlset', entries, sitemaps: [] };
  return { kind: 'unknown', entries: [], sitemaps: [] };
}

function safeNormalise(value: string | undefined, baseUrl: string): string | null {
  if (!value) return null;
  try {
    const normalised = normaliseUrl(value, baseUrl);
    // A sitemap listing another site's URLs is either a mistake or an attempt
    // to have us crawl a third party. Either way, not ours to fetch.
    return isSameSite(normalised, baseUrl) ? normalised : null;
  } catch {
    return null;
  }
}

/** The conventional places a sitemap lives, tried when robots.txt names none. */
export function wellKnownSitemapUrls(origin: string): string[] {
  return [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap-index.xml`,
    // Shopify and WooCommerce defaults respectively.
    `${origin}/sitemap.xml?page=1`,
    `${origin}/wp-sitemap.xml`,
  ];
}

/**
 * Orders sitemap entries by how likely they are to be worth fetching.
 *
 * Product URLs first, then collections, then everything else; within a tier,
 * the most recently modified. This is what makes a bounded crawl productive
 * on a large catalogue instead of exhausting its budget on blog archives.
 */
export function prioritiseEntries(entries: SitemapEntry[]): SitemapEntry[] {
  const score = (entry: SitemapEntry): number => {
    const path = safePathname(entry.url);
    if (/\/products?\//.test(path)) return 0;
    if (/\/(collections?|category|categories|shop|store)\//.test(path)) return 1;
    if (/\/(about|contact|faq|shipping|returns|policies|policy|terms)/.test(path)) return 2;
    if (/\/(blog|news|articles?|posts?|tag|author)\//.test(path)) return 4;
    return 3;
  };

  return [...entries].sort((a, b) => {
    const byScore = score(a) - score(b);
    if (byScore !== 0) return byScore;

    const aTime = a.lastModified?.getTime() ?? 0;
    const bTime = b.lastModified?.getTime() ?? 0;
    if (aTime !== bTime) return bTime - aTime;

    return (b.priority ?? 0) - (a.priority ?? 0);
  });
}

function safePathname(url: string): string {
  try {
    return new URL(url).pathname.toLowerCase();
  } catch {
    return '';
  }
}

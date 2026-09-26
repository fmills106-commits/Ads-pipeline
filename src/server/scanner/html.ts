import { parse, type HTMLElement } from 'node-html-parser';
import type { Availability, ExtractionMethod, PageType } from '@prisma/client';
import { isSameSite, normaliseUrl } from '@/lib/net-safety';
import { extractStatedOffers, parsePrice, type StatedOffer } from './price';
import { sanitiseExtractedText, scanForInjectionSignals } from './untrusted';

/**
 * HTML extraction.
 *
 * Four strategies, tried in descending order of trust:
 *
 *   JSON_LD    schema.org data the merchant published deliberately
 *   MICRODATA  itemprop attributes — also deliberate, slightly less reliable
 *   OPENGRAPH  og:/twitter: meta tags, aimed at social previews
 *   HTML       title, h1, and common ecommerce markup
 *   TEXT_PATTERN  pattern-matched from visible text — lowest confidence
 *
 * Every extracted value carries the method that produced it and the URL it
 * came from, so the fact/inference distinction the product depends on is a
 * property of the data rather than a convention. Nothing here invents a value:
 * when a field is absent, it stays absent.
 */

export const CONFIDENCE_BY_METHOD: Record<ExtractionMethod, number> = {
  JSON_LD: 0.95,
  MICRODATA: 0.9,
  OPENGRAPH: 0.8,
  HTML: 0.7,
  TEXT_PATTERN: 0.5,
  MERCHANT_PROVIDED: 1,
};

/** One extracted value with its provenance. */
export interface ExtractedValue<T = string> {
  value: T;
  method: ExtractionMethod;
  confidence: number;
  /** The snippet the value came from, for auditing. */
  excerpt?: string;
}

const value = <T>(v: T, method: ExtractionMethod, excerpt?: string): ExtractedValue<T> => ({
  value: v,
  method,
  confidence: CONFIDENCE_BY_METHOD[method],
  ...(excerpt === undefined ? {} : { excerpt: excerpt.slice(0, 300) }),
});

/** Keeps the highest-confidence candidate for a field. */
function best<T>(
  current: ExtractedValue<T> | undefined,
  candidate: ExtractedValue<T> | undefined,
): ExtractedValue<T> | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  return candidate.confidence > current.confidence ? candidate : current;
}

export interface ExtractedProduct {
  name?: ExtractedValue;
  description?: ExtractedValue;
  priceCents?: ExtractedValue<number>;
  comparePriceCents?: ExtractedValue<number>;
  currency?: ExtractedValue;
  availability?: ExtractedValue<Availability>;
  sku?: ExtractedValue;
  brand?: ExtractedValue;
  category?: ExtractedValue;
  images: Array<{
    url: string;
    altText?: string;
    isPrimary: boolean;
    /** As the page declares them. See `declaredSize`. */
    width?: number;
    height?: number;
  }>;
  statedOffers: StatedOffer[];
  callsToAction: string[];
  /**
   * Distinguishes several products found on one page.
   *
   * A page that is about a single product leaves this undefined, and that
   * product is identified by the page's own URL — the behaviour since Phase 2,
   * and what keeps a product's price history attached to it across scans. A
   * page that offers several (a one-page shop, a pricing grid) needs something
   * more specific, so each one carries a short stable identifier taken from the
   * page: the element's `id`, else its `data-sku`, else a slug of its name.
   *
   * It is an identifier, not a promise of a working anchor link: the element it
   * names may have no `id` for a browser to scroll to.
   */
  pageAnchor?: string;
}

export interface ExtractedBusiness {
  name?: ExtractedValue;
  description?: ExtractedValue;
  email?: ExtractedValue;
  phone?: ExtractedValue;
  address?: ExtractedValue;
  socialProfiles: string[];
}

export interface PageExtraction {
  title: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  pageType: PageType;
  /** Visible text, sanitised. UNTRUSTED. */
  text: string;
  /** Raw JSON-LD / OpenGraph / microdata, for storage and later re-analysis. */
  structuredData: {
    jsonLd: unknown[];
    openGraph: Record<string, string>;
    microdata: Record<string, string>;
  };
  links: string[];
  business: ExtractedBusiness;
  /**
   * What the page says its own images show, from their alt text.
   *
   * The cheapest product information on the web, and it was being discarded
   * entirely: `extractVisibleText` reads text nodes, and alt lives in an
   * attribute. A real storefront named its twelve Halloween designs only here
   * — "Sunset Bats squishy, sealed in its wrapper", and eleven more — while
   * the advertisement written from that page said "See the details and decide
   * for yourself."
   *
   * This is not image recognition. It is reading what the merchant already
   * wrote about their own pictures, which costs nothing and which no model can
   * improve on for the images that have it.
   */
  imageAlts: string[];

  /**
   * Every product this page offers, in the order they appear.
   *
   * Usually empty or one. A one-page shop and a pricing grid put several on a
   * single page, which was invisible to this extractor until a real
   * single-page storefront — four pack sizes in one section on the front page
   * — came back with nothing at all.
   */
  products: ExtractedProduct[];
  /** Advisory: text on the page resembling an instruction to an AI. */
  injectionSignals: string[];
}

const MAX_TEXT_CHARS = 40_000;
const MAX_LINKS = 500;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function extractFromHtml(html: string, pageUrl: string): PageExtraction {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    // Script contents are needed: JSON-LD lives inside <script type=…>.
    blockTextElements: { script: true, noscript: false, style: false, pre: true },
  });

  const jsonLd = extractJsonLd(root);
  const openGraph = extractMetaMap(root);
  const microdata = extractMicrodata(root);

  const title = textOf(root.querySelector('title')) ?? null;
  const metaDescription = openGraph['description'] ?? openGraph['og:description'] ?? null;
  const canonicalUrl = resolveMaybe(
    root.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    pageUrl,
  );

  const text = extractVisibleText(root);
  const links = extractLinks(root, pageUrl);

  const business = extractBusiness({ root, jsonLd, openGraph, text, pageUrl });
  const products = extractProducts({ root, jsonLd, openGraph, text, pageUrl });

  const pageType = classifyPageType({
    pageUrl,
    title,
    text,
    product: products[0] ?? null,
    jsonLd,
  });

  return {
    title,
    metaDescription,
    canonicalUrl,
    pageType,
    text,
    structuredData: { jsonLd, openGraph, microdata },
    links,
    business,
    imageAlts: extractImageAlts(root),
    products,
    injectionSignals: scanForInjectionSignals(`${title ?? ''}\n${text}`).signals,
  };
}

// ---------------------------------------------------------------------------
// Structured data
// ---------------------------------------------------------------------------

/** Parses every `<script type="application/ld+json">` block, tolerating junk. */
export function extractJsonLd(root: HTMLElement): unknown[] {
  const blocks: unknown[] = [];

  for (const node of root.querySelectorAll('script')) {
    const type = (node.getAttribute('type') ?? '').toLowerCase();
    if (!type.includes('ld+json')) continue;

    const raw = node.rawText ?? node.text ?? '';
    if (raw.trim() === '') continue;

    try {
      const parsed: unknown = JSON.parse(raw);
      // A @graph wrapper is extremely common; flatten it so callers do not
      // each have to know about it.
      if (parsed !== null && typeof parsed === 'object' && '@graph' in parsed) {
        const graph = (parsed as { '@graph': unknown })['@graph'];
        if (Array.isArray(graph)) {
          blocks.push(...graph);
          continue;
        }
      }
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else blocks.push(parsed);
    } catch {
      // Malformed JSON-LD is common and is not an error worth failing a scan
      // over. The other strategies still apply.
    }
  }

  return blocks.slice(0, 50);
}

/** Collects `<meta>` name/property values, including OpenGraph and Twitter. */
export function extractMetaMap(root: HTMLElement): Record<string, string> {
  const map: Record<string, string> = {};

  for (const node of root.querySelectorAll('meta')) {
    const key = (node.getAttribute('property') ?? node.getAttribute('name') ?? '')
      .trim()
      .toLowerCase();
    const content = node.getAttribute('content')?.trim();
    if (key === '' || !content) continue;
    if (map[key] === undefined) map[key] = content.slice(0, 2_000);
  }

  return map;
}

/**
 * The properties whose value is the element's link, not its text.
 *
 * This distinction matters: `<a itemprop="name" href="/product/120">Chromebook
 * 11</a>` means the name is "Chromebook 11". Preferring `href` for every
 * property extracted that product's name as
 * "/test-sites/e-commerce/allinone/product/120".
 */
const LINK_VALUED_ITEMPROPS = new Set([
  'url',
  'sameas',
  'availability',
  'itemcondition',
  'image',
  'logo',
  'contenturl',
  'thumbnailurl',
  'additionaltype',
]);

/** Reads one `itemprop`'s value, preferring the right source for its type. */
function itemPropValue(node: HTMLElement, key: string): string | null {
  const content = node.getAttribute('content')?.trim();
  if (content) return content;

  if (LINK_VALUED_ITEMPROPS.has(key)) {
    const link = (node.getAttribute('href') ?? node.getAttribute('src'))?.trim();
    if (link) return link;
  }

  const datetime = node.getAttribute('datetime')?.trim();
  if (datetime) return datetime;

  const text = node.text?.trim();
  if (text) return text;

  // A void element with no text, e.g. `<link itemprop="foo" href="…">`.
  return (node.getAttribute('href') ?? node.getAttribute('src'))?.trim() ?? null;
}

/** Collects microdata `itemprop` values. */
export function extractMicrodata(root: HTMLElement): Record<string, string> {
  const map: Record<string, string> = {};

  for (const node of root.querySelectorAll('[itemprop]')) {
    const key = node.getAttribute('itemprop')?.trim().toLowerCase();
    if (!key) continue;

    const content = itemPropValue(node, key);
    if (!content) continue;
    if (map[key] === undefined) map[key] = content.slice(0, 2_000);
  }

  return map;
}

/**
 * Microdata belonging to a `schema.org/Product` itemscope, and only that.
 *
 * `extractMicrodata` above deliberately flattens the whole page, which is the
 * right shape for storage but wrong for product extraction: a `WebSite`,
 * `Course` or `Organization` itemscope also has an `itemprop="name"`, and a
 * pricing table has an `itemprop="price"`. Reading the flat map is how a
 * homepage came to be extracted as a product called "Home" costing $1,187.98.
 *
 * Descendants are included, because `price`, `priceCurrency` and
 * `availability` normally sit in a nested `Offer` itemscope.
 */
export function extractProductMicrodata(root: HTMLElement): Record<string, string> {
  const map: Record<string, string> = {};

  for (const scope of root.querySelectorAll('[itemtype*="schema.org/Product" i]')) {
    for (const node of scope.querySelectorAll('[itemprop]')) {
      const key = node.getAttribute('itemprop')?.trim().toLowerCase();
      if (!key) continue;

      const content = itemPropValue(node, key);
      if (!content) continue;
      if (map[key] === undefined) map[key] = content.slice(0, 2_000);
    }
  }

  return map;
}

/** Finds JSON-LD nodes of a given schema.org type. */
function findJsonLdOfType(blocks: unknown[], types: string[]): Record<string, unknown>[] {
  const wanted = new Set(types.map((type) => type.toLowerCase()));
  const found: Record<string, unknown>[] = [];

  const visit = (node: unknown, depth: number): void => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }

    const record = node as Record<string, unknown>;
    const rawType = record['@type'];
    const typeList = Array.isArray(rawType) ? rawType : [rawType];
    if (typeList.some((type) => typeof type === 'string' && wanted.has(type.toLowerCase()))) {
      found.push(record);
    }

    for (const nested of Object.values(record)) visit(nested, depth + 1);
  };

  for (const block of blocks) visit(block, 0);
  return found;
}

function firstString(input: unknown): string | undefined {
  if (typeof input === 'string' && input.trim() !== '') return input.trim();
  if (typeof input === 'number') return String(input);
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = firstString(item);
      if (found !== undefined) return found;
    }
  }
  if (input !== null && typeof input === 'object') {
    const record = input as Record<string, unknown>;
    // schema.org values are often `{ "@value": … }` or `{ "name": … }`.
    return firstString(record['@value'] ?? record['name'] ?? record['url']);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Text and links
// ---------------------------------------------------------------------------

const NON_CONTENT_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'iframe'];

export function extractVisibleText(root: HTMLElement): string {
  // Work on a clone so removing chrome does not disturb other extractors.
  const clone = parse(root.toString(), { lowerCaseTagName: true, comment: false });

  for (const selector of [...NON_CONTENT_TAGS, 'nav', 'footer', 'header[role="banner"]']) {
    for (const node of clone.querySelectorAll(selector)) node.remove();
  }

  const raw = clone.text.replace(/&nbsp;/gi, ' ');
  return sanitiseExtractedText(raw).slice(0, MAX_TEXT_CHARS);
}

/** Same-site, http(s), deduplicated links. */
export function extractLinks(root: HTMLElement, pageUrl: string): string[] {
  const seen = new Set<string>();

  for (const anchor of root.querySelectorAll('a')) {
    if (seen.size >= MAX_LINKS) break;

    const href = anchor.getAttribute('href')?.trim();
    if (!href) continue;
    if (/^(?:#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;

    try {
      const resolved = normaliseUrl(href, pageUrl);
      const url = new URL(resolved);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      // The crawler stays on the merchant's own site.
      if (!isSameSite(url, pageUrl)) continue;
      // Binary assets are not pages.
      if (
        /\.(?:jpe?g|png|gif|webp|avif|svg|pdf|zip|mp4|mp3|css|js|ico|woff2?)$/i.test(url.pathname)
      ) {
        continue;
      }
      seen.add(resolved);
    } catch {
      continue;
    }
  }

  return [...seen];
}

/** How many image descriptions one page may contribute. */
const MAX_IMAGE_ALTS = 60;

/**
 * The alt text of a page's images, deduplicated and cleaned.
 *
 * Decorative images carry `alt=""` by design — that is the accessible way to
 * say "this picture means nothing" — so an empty one is skipped rather than
 * recorded as an unknown. A one-word alt is skipped too: "photo", "image" and
 * a filename tell a writer nothing and would dilute the ones that do.
 */
export function extractImageAlts(root: HTMLElement): string[] {
  const seen = new Set<string>();

  for (const image of root.querySelectorAll('img')) {
    if (seen.size >= MAX_IMAGE_ALTS) break;

    const alt = image.getAttribute('alt')?.replace(/\s+/g, ' ').trim();
    if (!alt) continue;
    // Two words at minimum, and not just a file name.
    if (alt.split(' ').length < 2) continue;
    if (/\.(?:jpe?g|png|webp|gif|svg|avif)$/i.test(alt)) continue;

    seen.add(alt.slice(0, 300));
  }

  return [...seen];
}

// ---------------------------------------------------------------------------
// Business details
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
// Deliberately conservative: a loose phone regex matches order numbers,
// dimensions and SKUs, and a wrong phone number in an advert is worse than none.
const PHONE_PATTERN =
  /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]\d{3,4}(?:[\s.-]\d{2,4})?/;

const SOCIAL_HOSTS = [
  'facebook.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'youtube.com',
  'linkedin.com',
  'pinterest.com',
];

function extractBusiness(input: {
  root: HTMLElement;
  jsonLd: unknown[];
  openGraph: Record<string, string>;
  text: string;
  pageUrl: string;
}): ExtractedBusiness {
  const { root, jsonLd, openGraph, text, pageUrl } = input;
  const result: ExtractedBusiness = { socialProfiles: [] };

  // --- JSON-LD Organization / LocalBusiness / WebSite -------------------
  for (const node of findJsonLdOfType(jsonLd, [
    'Organization',
    'LocalBusiness',
    'Store',
    'WebSite',
    'Corporation',
  ])) {
    const name = firstString(node['name']);
    if (name) result.name = best(result.name, value(name, 'JSON_LD'));

    const description = firstString(node['description']);
    if (description) result.description = best(result.description, value(description, 'JSON_LD'));

    const email = firstString(node['email']);
    if (email) result.email = best(result.email, value(email.replace(/^mailto:/i, ''), 'JSON_LD'));

    const phone = firstString(node['telephone']);
    if (phone) result.phone = best(result.phone, value(phone, 'JSON_LD'));

    const address = node['address'];
    const addressText =
      typeof address === 'string'
        ? address
        : address !== null && typeof address === 'object'
          ? [
              firstString((address as Record<string, unknown>)['streetAddress']),
              firstString((address as Record<string, unknown>)['addressLocality']),
              firstString((address as Record<string, unknown>)['addressRegion']),
              firstString((address as Record<string, unknown>)['postalCode']),
              firstString((address as Record<string, unknown>)['addressCountry']),
            ]
              .filter(Boolean)
              .join(', ')
          : undefined;
    if (addressText) result.address = best(result.address, value(addressText, 'JSON_LD'));

    const sameAs = node['sameAs'];
    for (const link of Array.isArray(sameAs) ? sameAs : [sameAs]) {
      const href = firstString(link);
      if (href && SOCIAL_HOSTS.some((host) => href.includes(host)))
        result.socialProfiles.push(href);
    }
  }

  // --- OpenGraph --------------------------------------------------------
  const ogSiteName = openGraph['og:site_name'];
  if (ogSiteName) result.name = best(result.name, value(ogSiteName, 'OPENGRAPH'));

  const ogDescription = openGraph['og:description'] ?? openGraph['description'];
  if (ogDescription)
    result.description = best(result.description, value(ogDescription, 'OPENGRAPH'));

  // --- HTML -------------------------------------------------------------
  const mailto = root.querySelector('a[href^="mailto:"]')?.getAttribute('href');
  if (mailto) {
    const email = mailto
      .replace(/^mailto:/i, '')
      .split('?')[0]!
      .trim();
    if (EMAIL_PATTERN.test(email)) result.email = best(result.email, value(email, 'HTML'));
  }

  const tel = root.querySelector('a[href^="tel:"]')?.getAttribute('href');
  if (tel) {
    const phone = tel.replace(/^tel:/i, '').trim();
    if (phone !== '') result.phone = best(result.phone, value(phone, 'HTML'));
  }

  for (const anchor of root.querySelectorAll('a')) {
    const href = anchor.getAttribute('href');
    if (!href) continue;
    if (SOCIAL_HOSTS.some((host) => href.includes(host))) result.socialProfiles.push(href);
  }

  if (!result.name) {
    // Fall back to the site's own host name rather than a page title, which is
    // usually "Product name – Shop name" and would extract badly.
    try {
      const host = new URL(pageUrl).hostname.replace(/^www\./, '');
      result.name = value(host, 'HTML', host);
    } catch {
      /* no host to fall back to */
    }
  }

  // --- Text patterns, lowest confidence ---------------------------------
  if (!result.email) {
    const match = EMAIL_PATTERN.exec(text);
    if (match) result.email = value(match[0], 'TEXT_PATTERN', match[0]);
  }
  if (!result.phone) {
    // Only trust a text-matched phone number when it is labelled as one.
    const labelled = /(?:tel|phone|call us|call)[:\s]*([+\d(][\d\s().-]{6,})/i.exec(text);
    if (labelled?.[1]) {
      const candidate = labelled[1].trim();
      if (PHONE_PATTERN.test(candidate)) {
        result.phone = value(candidate, 'TEXT_PATTERN', labelled[0]);
      }
    }
  }

  result.socialProfiles = [...new Set(result.socialProfiles)].slice(0, 20);
  return result;
}

// ---------------------------------------------------------------------------
// Product details
// ---------------------------------------------------------------------------

const CTA_PATTERNS = [
  /\badd to (?:cart|bag|basket)\b/i,
  /\bbuy (?:now|it now)\b/i,
  /\bshop now\b/i,
  /\border now\b/i,
  /\bpre-?order\b/i,
  /\bsubscribe\b/i,
  /\bbook (?:now|a call)\b/i,
  /\bget (?:started|a quote|yours)\b/i,
  /\blearn more\b/i,
  /\bsign up\b/i,
  /\bcontact us\b/i,
];

function normaliseAvailability(raw: string | undefined): Availability | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower.includes('instock') || lower.includes('in stock') || lower.includes('available')) {
    return 'IN_STOCK';
  }
  if (
    lower.includes('outofstock') ||
    lower.includes('out of stock') ||
    lower.includes('sold out')
  ) {
    return 'OUT_OF_STOCK';
  }
  if (lower.includes('preorder') || lower.includes('pre-order') || lower.includes('backorder')) {
    return 'PREORDER';
  }
  return undefined;
}

interface ProductExtractionInput {
  root: HTMLElement;
  jsonLd: unknown[];
  openGraph: Record<string, string>;
  text: string;
  pageUrl: string;
}

/**
 * Every product on the page.
 *
 * Three paths, tried in order of how explicitly the merchant declared what
 * they sell. Only the first one that yields anything is used, so a product page
 * with a "you may also like" strip does not report its neighbours as its own
 * products.
 *
 *  1. **Several declared products.** Two or more `schema.org/Product` nodes in
 *     JSON-LD, or two or more Product itemscopes in microdata. Each becomes a
 *     product in its own right.
 *  2. **One product.** The original path, unchanged: everything on the page
 *     merged into a single product, with the guards that stop a category page
 *     or a homepage becoming one. A single declared node still goes through
 *     here, because merging JSON-LD with microdata and OpenGraph produces a
 *     better-populated product than any one source alone.
 *  3. **A repeated group of priced offers.** No structured data at all, but a
 *     row of sibling elements each carrying one price and a name — a pricing
 *     grid, or the "pick your pack" section of a one-page shop.
 */
function extractProducts(input: ProductExtractionInput): ExtractedProduct[] {
  const declared = extractDeclaredProducts(input);
  if (declared.length > 1) return declared;

  const single = extractProduct(input);
  if (single) return [single];

  return extractOfferGroup(input);
}

function extractProduct(input: {
  root: HTMLElement;
  jsonLd: unknown[];
  openGraph: Record<string, string>;
  text: string;
  pageUrl: string;
}): ExtractedProduct | null {
  const { root, jsonLd, openGraph, text, pageUrl } = input;

  const productNodes = findJsonLdOfType(jsonLd, ['Product', 'ProductGroup']);
  const ogType = (openGraph['og:type'] ?? '').toLowerCase();

  /**
   * The page says, in structured data, that it is about one product. This is a
   * deliberate statement by the merchant, so it is taken at face value.
   */
  const declaredProduct =
    productNodes.length > 0 ||
    ogType.includes('product') ||
    root.querySelector('[itemtype*="schema.org/Product" i]') !== null;

  /**
   * Circumstantial. A category page, a search result page and a homepage
   * carousel all carry "add to basket" buttons and labelled prices — one per
   * item — so this needs corroboration before anything is extracted from it.
   *
   * The labelled-price case is not redundant with the add-to-cart one: a real
   * bookshop tested against this puts its basket button only on category
   * pages, so its product pages had no cart signal at all and yielded nothing.
   */
  const circumstantial =
    ADD_TO_CART.test(text) ||
    root.querySelector('[itemprop="price" i]') !== null ||
    root.querySelector('[class*="price" i]') !== null;

  if (!declaredProduct && !circumstantial) return null;

  /*
   * A site's front page is never one product unless its own structured data
   * says so. It is the page most likely to carry a stray price — a carousel,
   * a "from $9" banner, a pricing table — and the least likely to be about a
   * single item. Guessing here produced a product called "Home".
   */
  if (!declaredProduct && isSiteRoot(pageUrl)) return null;

  // Only microdata inside a Product itemscope describes this product.
  const productMicrodata = declaredProduct ? extractProductMicrodata(root) : {};

  const result: ExtractedProduct = { images: [], statedOffers: [], callsToAction: [] };

  // --- JSON-LD Product (highest trust) ----------------------------------
  for (const node of productNodes) {
    const name = firstString(node['name']);
    if (name) result.name = best(result.name, value(name, 'JSON_LD'));

    const description = firstString(node['description']);
    if (description) result.description = best(result.description, value(description, 'JSON_LD'));

    const sku = firstString(node['sku'] ?? node['mpn'] ?? node['productID'] ?? node['gtin13']);
    if (sku) result.sku = best(result.sku, value(sku, 'JSON_LD'));

    const brand = firstString(node['brand']);
    if (brand) result.brand = best(result.brand, value(brand, 'JSON_LD'));

    const category = firstString(node['category']);
    if (category) result.category = best(result.category, value(category, 'JSON_LD'));

    // Offers carry price, currency and availability.
    const offersRaw = node['offers'];
    const offers = (Array.isArray(offersRaw) ? offersRaw : [offersRaw]).filter(
      (offer): offer is Record<string, unknown> => offer !== null && typeof offer === 'object',
    );

    for (const offer of offers) {
      const currency = firstString(offer['priceCurrency']);
      if (currency) result.currency = best(result.currency, value(currency, 'JSON_LD'));

      const priceText = firstString(offer['price'] ?? offer['lowPrice']);
      if (priceText) {
        const parsed = parsePrice(priceText, currency ?? result.currency?.value ?? null);
        if (parsed) {
          result.priceCents = best(result.priceCents, value(parsed.cents, 'JSON_LD', priceText));
          if (parsed.currency) {
            result.currency = best(result.currency, value(parsed.currency, 'JSON_LD'));
          }
        }
      }

      const availability = normaliseAvailability(firstString(offer['availability']));
      if (availability)
        result.availability = best(result.availability, value(availability, 'JSON_LD'));
    }

    const images = node['image'];
    for (const image of Array.isArray(images) ? images : [images]) {
      const href = firstString(image);
      const resolved = resolveMaybe(href, pageUrl);
      if (resolved) {
        result.images.push({ url: resolved, isPrimary: result.images.length === 0 });
      }
    }
  }

  // --- Microdata --------------------------------------------------------
  if (productMicrodata['name']) {
    result.name = best(result.name, value(productMicrodata['name'], 'MICRODATA'));
  }
  if (productMicrodata['sku']) {
    result.sku = best(result.sku, value(productMicrodata['sku'], 'MICRODATA'));
  }
  if (productMicrodata['brand']) {
    result.brand = best(result.brand, value(productMicrodata['brand'], 'MICRODATA'));
  }
  if (productMicrodata['pricecurrency']) {
    result.currency = best(result.currency, value(productMicrodata['pricecurrency'], 'MICRODATA'));
  }
  if (productMicrodata['price']) {
    const parsed = parsePrice(productMicrodata['price'], result.currency?.value ?? null);
    if (parsed) {
      result.priceCents = best(
        result.priceCents,
        value(parsed.cents, 'MICRODATA', productMicrodata['price']),
      );
    }
  }
  const microAvailability = normaliseAvailability(productMicrodata['availability']);
  if (microAvailability) {
    result.availability = best(result.availability, value(microAvailability, 'MICRODATA'));
  }

  // --- OpenGraph --------------------------------------------------------
  if (openGraph['og:title']) {
    result.name = best(result.name, value(openGraph['og:title'], 'OPENGRAPH'));
  }
  if (openGraph['og:description']) {
    result.description = best(result.description, value(openGraph['og:description'], 'OPENGRAPH'));
  }
  const ogCurrency = openGraph['product:price:currency'] ?? openGraph['og:price:currency'];
  if (ogCurrency) result.currency = best(result.currency, value(ogCurrency, 'OPENGRAPH'));

  const ogPrice = openGraph['product:price:amount'] ?? openGraph['og:price:amount'];
  if (ogPrice) {
    const parsed = parsePrice(ogPrice, ogCurrency ?? result.currency?.value ?? null);
    if (parsed) {
      result.priceCents = best(result.priceCents, value(parsed.cents, 'OPENGRAPH', ogPrice));
    }
  }
  const ogImage = resolveMaybe(openGraph['og:image'], pageUrl);
  if (ogImage) result.images.push({ url: ogImage, isPrimary: result.images.length === 0 });

  // --- HTML -------------------------------------------------------------
  if (!result.name) {
    const heading = textOf(root.querySelector('h1'));
    if (heading) result.name = value(heading, 'HTML', heading);
  }

  /**
   * The price, for a shop that publishes no structured data at all.
   *
   * Plenty do — a real bookshop tested against this had prices only in
   * `<p class="price_color">£51.77</p>`, so every product came back with no
   * price and was discarded. Two bounded attempts, in order of how much they
   * can be trusted, and neither runs on a page that looks like a list:
   *
   *   1. An element the markup itself labels as the price.
   *   2. A single distinct amount on the whole page — unambiguous by virtue
   *      of being the only candidate.
   *
   * Anything less certain than that stays absent. A wrong price is worse than
   * no price: it would be advertised.
   */
  if (result.priceCents === undefined && !looksLikeListing(text)) {
    const labelledNode =
      root.querySelector('[itemprop="price" i]') ??
      root.querySelector('[class*="price" i]') ??
      root.querySelector('[id*="price" i]');
    const labelled = textOf(labelledNode);

    // A long string is a container, not a price.
    const fromLabel =
      labelled !== undefined && labelled !== null && labelled.length <= 40
        ? parsePrice(labelled, result.currency?.value ?? null)
        : null;

    if (fromLabel && labelled) {
      result.priceCents = value(fromLabel.cents, 'HTML', labelled);
      if (!result.currency && fromLabel.currency) {
        result.currency = value(fromLabel.currency, 'HTML', labelled);
      }
    } else {
      const amounts = new Set((text.match(PRICE_SHAPED) ?? []).map((a) => a.replace(/\s+/g, '')));
      const only = amounts.size === 1 ? [...amounts][0] : undefined;
      const parsed = only ? parsePrice(only, result.currency?.value ?? null) : null;
      if (parsed && only) {
        result.priceCents = value(parsed.cents, 'TEXT_PATTERN', only);
        if (!result.currency && parsed.currency) {
          result.currency = value(parsed.currency, 'TEXT_PATTERN', only);
        }
      }
    }
  }

  // A "compare at" / "was" price, only where the markup labels it as one.
  const compareNode =
    root.querySelector('[class*="compare-at" i]') ??
    root.querySelector('[class*="was-price" i]') ??
    root.querySelector('[class*="original-price" i]') ??
    root.querySelector('s, del');
  const compareText = textOf(compareNode);
  if (compareText) {
    const parsed = parsePrice(compareText, result.currency?.value ?? null);
    if (parsed && (result.priceCents === undefined || parsed.cents > result.priceCents.value)) {
      result.comparePriceCents = value(parsed.cents, 'HTML', compareText);
    }
  }

  for (const node of root.querySelectorAll('img')) {
    if (result.images.length >= 12) break;
    const src = node.getAttribute('src') ?? node.getAttribute('data-src');
    const resolved = resolveMaybe(src, pageUrl);
    if (!resolved) continue;
    const alt = node.getAttribute('alt')?.trim();
    result.images.push({
      url: resolved,
      isPrimary: result.images.length === 0,
      ...(alt ? { altText: alt } : {}),
      ...declaredSize(node),
    });
  }

  // --- Offers and CTAs: only what the page literally says ---------------
  result.statedOffers = extractStatedOffers(text);

  const ctaSources = [
    ...root.querySelectorAll('button').map((node) => node.text),
    ...root.querySelectorAll('a').map((node) => node.text),
    ...root
      .querySelectorAll('input[type="submit"]')
      .map((node) => node.getAttribute('value') ?? ''),
  ];
  const ctas = new Set<string>();
  for (const source of ctaSources) {
    const label = source.trim().replace(/\s+/g, ' ');
    if (label === '' || label.length > 40) continue;
    if (CTA_PATTERNS.some((pattern) => pattern.test(label))) ctas.add(label);
  }
  result.callsToAction = [...ctas].slice(0, 12);

  // Deduplicate images, preserving order and the primary flag.
  const seenImages = new Set<string>();
  result.images = result.images.filter((image) => {
    if (seenImages.has(image.url)) return false;
    seenImages.add(image.url);
    return true;
  });

  // A product with no name is not usable downstream.
  if (!result.name) return null;

  // Structured data settled it; nothing further to prove.
  if (declaredProduct) return result;

  // Everything below here got in on circumstantial evidence alone, and the
  // name almost certainly came from the page's `<h1>`. On a real bookshop's
  // category pages that produced products called "Travel" and "Mystery" with
  // no price, and on a homepage a product called "Home" priced from a stray
  // microdata block in a carousel. Neither exists.
  //
  // So: a price that plausibly belongs to *this* page, and no sign that the
  // page is a list of many things. Refusing here loses the occasional real
  // product from a site with no structured data at all — which the scan
  // reports as pages read without products found, rather than inventing
  // inventory the merchant does not sell.
  if (result.priceCents === undefined) return null;
  if (looksLikeListing(text)) return null;

  return result;
}

// ---------------------------------------------------------------------------
// Several products on one page
// ---------------------------------------------------------------------------

/** How many products one page may contribute. A guard against a runaway list. */
const MAX_PRODUCTS_PER_PAGE = 24;

/**
 * One product per declared node.
 *
 * Trust comes from the merchant having written the markup, so there is no
 * homepage guard here and no corroboration required: a page that declares four
 * Products is a page with four products, wherever it sits on the site.
 *
 * Fields are read only from within each node, never merged across them —
 * merging is what turned a carousel of microdata into a single product called
 * "Home" priced at $1,187.98.
 */
function extractDeclaredProducts(input: ProductExtractionInput): ExtractedProduct[] {
  const { root, jsonLd } = input;
  const products: ExtractedProduct[] = [];

  for (const node of findJsonLdOfType(jsonLd, ['Product', 'ProductGroup'])) {
    const product = productFromJsonLdNode(node);
    if (product) products.push(product);
  }
  if (products.length > 1) return products.slice(0, MAX_PRODUCTS_PER_PAGE);

  // Microdata, scoped to each itemscope rather than the whole document.
  const scopes = root.querySelectorAll('[itemtype*="schema.org/Product" i]');
  if (scopes.length > 1) {
    const fromMicrodata: ExtractedProduct[] = [];
    for (const scope of scopes) {
      const product = productFromMicrodataScope(scope);
      if (product) fromMicrodata.push(product);
    }
    if (fromMicrodata.length > 1) return fromMicrodata.slice(0, MAX_PRODUCTS_PER_PAGE);
  }

  return products;
}

function productFromJsonLdNode(node: Record<string, unknown>): ExtractedProduct | null {
  const name = firstString(node['name']);
  if (!name) return null;

  const product: ExtractedProduct = {
    name: value(name, 'JSON_LD'),
    images: [],
    statedOffers: [],
    callsToAction: [],
  };

  const description = firstString(node['description']);
  if (description) product.description = value(description, 'JSON_LD');

  const sku = firstString(node['sku'] ?? node['mpn'] ?? node['productID'] ?? node['gtin13']);
  if (sku) {
    product.sku = value(sku, 'JSON_LD');
    product.pageAnchor = slugFor(sku);
  }
  product.pageAnchor ??= slugFor(name);

  const brand = firstString(node['brand']);
  if (brand) product.brand = value(brand, 'JSON_LD');

  const category = firstString(node['category']);
  if (category) product.category = value(category, 'JSON_LD');

  for (const offer of offersOf(node)) {
    const price = firstString(offer['price'] ?? offer['lowPrice']);
    const currency = firstString(offer['priceCurrency']);
    if (price) {
      const parsed = parsePrice(price, currency);
      if (parsed) product.priceCents = value(parsed.cents, 'JSON_LD');
    }
    if (currency) product.currency = value(currency.toUpperCase(), 'JSON_LD');

    const availability = firstString(offer['availability']);
    const normalised = availability ? normaliseAvailability(availability) : undefined;
    if (normalised) product.availability = value(normalised, 'JSON_LD');
  }

  return product;
}

function productFromMicrodataScope(scope: HTMLElement): ExtractedProduct | null {
  const fields = extractProductMicrodata(scope);
  const name = fields['name'];
  if (!name) return null;

  const product: ExtractedProduct = {
    name: value(name, 'MICRODATA'),
    images: [],
    statedOffers: [],
    callsToAction: [],
  };

  const description = fields['description'];
  if (description) product.description = value(description, 'MICRODATA');

  const sku = fields['sku'];
  if (sku) product.sku = value(sku, 'MICRODATA');

  const currency = fields['priceCurrency'];
  if (currency) product.currency = value(currency.toUpperCase(), 'MICRODATA');

  const price = fields['price'];
  if (price) {
    const parsed = parsePrice(price, currency ?? null);
    if (parsed) product.priceCents = value(parsed.cents, 'MICRODATA');
  }

  const availability = fields['availability'];
  const normalised = availability ? normaliseAvailability(availability) : undefined;
  if (normalised) product.availability = value(normalised, 'MICRODATA');

  product.pageAnchor = scope.getAttribute('id') ?? slugFor(sku ?? name);

  return product;
}

/*
 * Inside a card, these describe something other than the price of the thing
 * itself, and a card that mentions both would otherwise be priced by whichever
 * number came first. Smooshery's single pack reads "$15 … + $4.99 on its own";
 * the product costs $15.
 */
const NOT_THE_PRICE = /ship|deliver|postage|tax|vat|was|rrp|instead|save|compare|from\b/i;

/** A price, and the element it was written in, for deciding what it means. */
const PRICEY = /[$£€¥]\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|EUR|GBP|AUD|CAD)/;

/**
 * A repeated group of priced offers, for a page with no structured data.
 *
 * This is the loosest path in the extractor, so it is the most constrained. It
 * looks for what a pricing grid actually is — sibling elements of the same
 * shape, each naming one thing and one price — rather than for prices on a
 * page, which is the mistake that produced a product called "Home".
 *
 * The structure is the evidence. A carousel of unrelated prices does not
 * repeat a class signature with one price per item; a "pick your pack" section
 * does. Requiring at least two matching siblings, and exactly one price inside
 * each after shipping and comparison prices are set aside, is what separates
 * them.
 *
 * Everything here is recorded as method HTML, the lowest trust tier above
 * guessing from prose, so downstream code and the owner can both see that it
 * was inferred from layout rather than declared.
 */
function extractOfferGroup(input: ProductExtractionInput): ExtractedProduct[] {
  const { root, text } = input;

  // Something on the page must be for sale. Without this, a comparison table
  // in a blog post becomes a product line.
  const purchaseIntent =
    ADD_TO_CART.test(text) || /\bbuy now\b|\bcheckout\b|\border now\b/i.test(text);
  if (!purchaseIntent) return [];

  let bestGroup: ExtractedProduct[] = [];

  for (const container of root.querySelectorAll('*')) {
    const children = container.childNodes.filter(isElement);
    if (children.length < 2) continue;

    // Same shape: the first class token, or the tag name when unclassed.
    const bySignature = new Map<string, HTMLElement[]>();
    for (const child of children) {
      const signature = signatureOf(child);
      const group = bySignature.get(signature) ?? [];
      group.push(child);
      bySignature.set(signature, group);
    }

    for (const siblings of bySignature.values()) {
      if (siblings.length < 2) continue;
      if (isInsideCart(siblings[0])) continue;

      const products: ExtractedProduct[] = [];
      for (const card of siblings) {
        const product = productFromCard(card, input.pageUrl);
        if (product) products.push(product);
      }

      // Every sibling of the same shape should be a card. If only some are,
      // the "group" is a coincidence of class names rather than a grid.
      if (products.length < 2 || products.length < siblings.length - 1) continue;
      if (products.length > bestGroup.length) bestGroup = products;
    }
  }

  return dedupeByName(bestGroup).slice(0, MAX_PRODUCTS_PER_PAGE);
}

/**
 * Whether this card sells something here, or merely points at it.
 *
 * This is the whole difference between a one-page shop and a category listing,
 * and the two are otherwise identical in shape: repeated siblings, each with a
 * name, a price and an add-to-basket button. A category card wraps its name in
 * a link to the product's own page; a pack card has nowhere to send you,
 * because the checkout is right there.
 *
 * Getting this wrong in the permissive direction is what a collection page in
 * the test suite caught immediately: four products invented on a page whose
 * four real products were about to be read properly, with full detail, from
 * their own pages.
 *
 * So a card that links out is declined. It costs nothing — the product is
 * extracted from the page it links to — and it means this path only ever fires
 * where there is no other page to get it from.
 */
function sellsInPlace(card: HTMLElement): boolean {
  for (const link of card.querySelectorAll('a')) {
    const href = (link.getAttribute('href') ?? '').trim();
    if (href && !href.startsWith('#')) return false;
  }

  if (card.getAttribute('data-sku') ?? card.getAttribute('data-add')) return true;

  for (const control of card.querySelectorAll('button, input[type="submit"]')) {
    const label = `${control.textContent ?? ''} ${control.getAttribute('value') ?? ''}`;
    if (ADD_TO_CART.test(label) || /\bbuy\b|\bchoose\b|\bselect\b|\border\b/i.test(label)) {
      return true;
    }
    if (control.getAttribute('data-add') ?? control.getAttribute('data-sku')) return true;
  }

  return false;
}

/**
 * A card's images, resolved to absolute URLs, with their alt text.
 *
 * `srcset` and `data-src` are read as well as `src`, because a lazy-loading
 * storefront leaves `src` as a placeholder pixel and puts the real picture in
 * one of the others — taking `src` alone would store a 1x1 transparent GIF as
 * the product photograph.
 */
/**
 * The size a page says an image is.
 *
 * Free, and worth having. `ProductImage` has carried `width` and `height`
 * since Phase 2 and nothing ever filled them, so the engine knew every
 * picture's address and nothing about its shape.
 *
 * Shape decides what can be advertised. Meta wants square and 4:5 and will not
 * take an image below about 1080px on its short side, so "this shop has
 * beautiful photographs, all 400px wide" is a real finding an owner can act
 * on — and a 32×32 file is a favicon, not a product shot, whatever it is
 * attached to.
 *
 * Read from the attributes rather than by downloading the file. Modern pages
 * declare them to stop the layout jumping, so this costs no request at all;
 * when a page does not declare them the size stays unknown, which is honest
 * and cheaper than fetching every image to find out.
 */
function declaredSize(node: HTMLElement): { width?: number; height?: number } {
  const read = (name: string): number | undefined => {
    const raw = node.getAttribute(name);
    if (!raw) return undefined;
    // Percentages and `auto` are layout, not pixels.
    const parsed = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 20_000) return undefined;
    return parsed;
  };

  const width = read('width');
  const height = read('height');
  return { ...(width === undefined ? {} : { width }), ...(height === undefined ? {} : { height }) };
}

function imagesWithin(
  card: HTMLElement,
  pageUrl: string,
): Array<{ url: string; altText?: string; isPrimary: boolean }> {
  const images: Array<{ url: string; altText?: string; isPrimary: boolean }> = [];
  const seen = new Set<string>();

  for (const image of card.querySelectorAll('img')) {
    /*
     * First candidate that is not a placeholder, rather than the first that
     * exists. `src ?? data-src` reads the data URI — it is present — and then
     * skipping it loses the image altogether, which is how a lazy-loading
     * storefront ends up with no product photographs at all.
     */
    const raw = [
      image.getAttribute('src'),
      image.getAttribute('data-src'),
      image.getAttribute('data-lazy-src'),
      image.getAttribute('srcset')?.split(',')[0]?.trim().split(/\s+/)[0],
    ]
      .map((candidate) => candidate?.trim())
      .find((candidate) => Boolean(candidate) && !candidate!.startsWith('data:'));

    if (!raw) continue;

    const resolved = resolveMaybe(raw, pageUrl);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);

    const alt = image.getAttribute('alt')?.replace(/\s+/g, ' ').trim();
    images.push({
      url: resolved,
      ...(alt ? { altText: alt.slice(0, 300) } : {}),
      isPrimary: images.length === 0,
      ...declaredSize(image),
    });

    if (images.length >= 6) break;
  }

  return images;
}

function productFromCard(card: HTMLElement, pageUrl: string): ExtractedProduct | null {
  if (!sellsInPlace(card)) return null;

  let price: { cents: number; currency: string | null; excerpt: string } | null = null;
  let name: string | null = null;

  for (const node of card.querySelectorAll('*')) {
    const own = ownText(node);
    if (!own) continue;

    const classes = `${node.getAttribute('class') ?? ''} ${own}`;

    if (PRICEY.test(own)) {
      if (price || NOT_THE_PRICE.test(classes)) continue;
      const parsed = parsePrice(own, null);
      // A price of nothing is a cart total, a placeholder or a free shipping
      // line — never the price of a product somebody is selling.
      if (parsed && parsed.cents > 0) {
        price = { cents: parsed.cents, currency: parsed.currency, excerpt: own };
      }
      continue;
    }

    if (name) continue;
    if (!isPlausibleName(own)) continue;
    // Prefer something the page labelled as a name or a heading; otherwise the
    // first short line that is not a price will do.
    if (/name|title/i.test(node.getAttribute('class') ?? '') || /^h[1-6]$/.test(node.rawTagName)) {
      name = own;
    } else {
      name ??= own;
    }
  }

  if (!price || !name) return null;

  const product: ExtractedProduct = {
    name: value(name, 'HTML', name),
    priceCents: value(price.cents, 'HTML', price.excerpt),
    // A card's own pictures, with whatever the merchant said they show. This
    // path returned an empty array at first, so a one-page shop's products had
    // no images and no alt text — the two things most worth having about a
    // physical product.
    images: imagesWithin(card, pageUrl),
    statedOffers: [],
    callsToAction: [],
  };
  if (price.currency) product.currency = value(price.currency, 'HTML');

  /*
   * The identifier is usually on the control rather than the card — it is
   * there for the page's own cart script, which needs it on the thing you
   * click. It is worth finding: it is the merchant's own name for the item, so
   * it survives a wording change to the label that a slug of the name would
   * not, and a product keeps its price history across that change.
   */
  const sku = skuWithin(card);
  if (sku) product.sku = value(sku, 'HTML');

  product.pageAnchor = card.getAttribute('id') ?? slugFor(sku ?? name);

  return product;
}

const SKU_ATTRIBUTES = ['data-sku', 'data-add', 'data-product-id', 'data-variant-id'] as const;

/** The merchant's own identifier for this item, from the card or its controls. */
function skuWithin(card: HTMLElement): string | null {
  for (const attribute of SKU_ATTRIBUTES) {
    const own = card.getAttribute(attribute)?.trim();
    if (own) return own.slice(0, 100);
  }
  for (const node of card.querySelectorAll('*')) {
    for (const attribute of SKU_ATTRIBUTES) {
      const found = node.getAttribute(attribute)?.trim();
      if (found) return found.slice(0, 100);
    }
  }
  return null;
}

/** A name, not a sentence, a price or a label like "Most popular". */
function isPlausibleName(candidate: string): boolean {
  if (candidate.length < 2 || candidate.length > 80) return false;
  if (PRICEY.test(candidate)) return false;
  if (NOT_THE_PRICE.test(candidate)) return false;
  if (/^(?:most popular|best value|new|sale|sold out|free)$/i.test(candidate)) return false;
  // A sentence is a description, not a name.
  return candidate.split(/\s+/).length <= 8 && !/[.!?]\s/.test(candidate);
}

/** Text belonging to this element, not to its descendants. */
function ownText(node: HTMLElement): string | null {
  const own = node.childNodes
    .filter((child) => !isElement(child))
    .map((child) => child.rawText)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return own.length > 0 ? own : null;
}

const isElement = (node: { nodeType: number }): node is HTMLElement => node.nodeType === 1;

function signatureOf(element: HTMLElement): string {
  const first = (element.getAttribute('class') ?? '').trim().split(/\s+/)[0];
  return first ? `.${first}` : element.rawTagName;
}

/** A cart, an order summary or a checkout panel is not a product listing. */
function isInsideCart(element: HTMLElement | undefined): boolean {
  let node: HTMLElement | null | undefined = element;
  for (let depth = 0; node && depth < 12; depth += 1) {
    const marker = `${node.getAttribute('class') ?? ''} ${node.getAttribute('id') ?? ''}`;
    if (/cart|basket|checkout|summary|subtotal|minicart/i.test(marker)) return true;
    node = node.parentNode as HTMLElement | null;
  }
  return false;
}

function dedupeByName(products: ExtractedProduct[]): ExtractedProduct[] {
  const seen = new Set<string>();
  return products.filter((product) => {
    const key = (product.name?.value ?? '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A node's `offers`, whether it holds one object or an array of them. */
function offersOf(node: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = node['offers'];
  return (Array.isArray(raw) ? raw : [raw]).filter(
    (offer): offer is Record<string, unknown> => offer !== null && typeof offer === 'object',
  );
}

/** A short, stable, URL-safe identifier. */
function slugFor(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'item'
  );
}

/** Whether a URL is a site's front page. */
function isSiteRoot(pageUrl: string): boolean {
  try {
    const { pathname } = new URL(pageUrl);
    return pathname === '/' || pathname === '' || /^\/index\.\w+$/i.test(pathname);
  } catch {
    return false;
  }
}

/**
 * "Add to basket", however the page's markup ran it together with what
 * precedes it.
 *
 * No leading `\b`, deliberately. `extractVisibleText` joins the document's
 * text nodes with no separator, so a card whose price sits in one element and
 * whose button sits in the next reads `£7.90Add to basket` — and a word
 * boundary between `0` and `A` does not exist. With `\b` this pattern found
 * none of the three add-to-basket buttons on a category listing, the listing
 * therefore did not look like a listing, and the page was stored as a single
 * product named after its heading: "Flours", priced at £7.90.
 *
 * Putting spaces between elements in the visible text would fix the boundary
 * and break something worse: a price split across elements —
 * `<span>$</span><span>15</span>` is ordinary storefront markup — would become
 * "$ 15" and stop parsing as money.
 */
const ADD_TO_CART = /add to (?:cart|bag|basket)\b/i;
const ADD_TO_CART_GLOBAL = /add to (?:cart|bag|basket)\b/gi;

/** Any currency-ish amount, for counting rather than parsing. */
const PRICE_SHAPED = /(?:[$£€¥]\s?\d[\d.,]*|\d[\d.,]*\s?(?:USD|EUR|GBP|AUD|CAD))/g;

/**
 * Whether the page looks like a list of items rather than one item.
 *
 * Counts distinct prices and add-to-cart phrases in the visible text. One
 * product page has a price and maybe a "was" price; a category page has
 * twenty of each. Deliberately text-only — markup class names vary by theme,
 * the shape of the content does not.
 */
function looksLikeListing(text: string): boolean {
  const distinctPrices = new Set(
    (text.match(PRICE_SHAPED) ?? []).map((p) => p.replace(/\s+/g, '')),
  );
  if (distinctPrices.size > 3) return true;

  return (text.match(ADD_TO_CART_GLOBAL) ?? []).length > 2;
}

// ---------------------------------------------------------------------------
// Page classification
// ---------------------------------------------------------------------------

const PATH_RULES: Array<{ type: PageType; pattern: RegExp }> = [
  { type: 'PRODUCT', pattern: /\/(?:products?|item|p)\/[^/]+/i },
  {
    type: 'COLLECTION',
    pattern: /\/(?:collections?|categor(?:y|ies)|shop|store|catalog(?:ue)?)(?:\/|$)/i,
  },
  { type: 'ABOUT', pattern: /\/(?:about|our-story|who-we-are|team)/i },
  { type: 'FAQ', pattern: /\/(?:faqs?|help|support|questions)/i },
  { type: 'SHIPPING', pattern: /\/(?:shipping|delivery|postage)/i },
  { type: 'RETURNS', pattern: /\/(?:returns?|refunds?|exchanges?)/i },
  { type: 'CONTACT', pattern: /\/(?:contact|get-in-touch|reach-us)/i },
  { type: 'POLICY', pattern: /\/(?:policies|policy|privacy|terms|legal|cookies?)/i },
  { type: 'BLOG', pattern: /\/(?:blogs?|news|articles?|posts?|journal)(?:\/|$)/i },
];

export function classifyPageType(input: {
  pageUrl: string;
  title: string | null;
  text: string;
  product: ExtractedProduct | null;
  jsonLd: unknown[];
}): PageType {
  const { pageUrl, title, text, product, jsonLd } = input;

  let pathname = '/';
  try {
    pathname = new URL(pageUrl).pathname;
  } catch {
    /* keep the default */
  }

  // Structured data is the strongest signal available.
  if (findJsonLdOfType(jsonLd, ['Product', 'ProductGroup']).length > 0) return 'PRODUCT';

  /*
   * A named, priced product beats a guess made from the URL. `extractProduct`
   * refuses to produce one for anything that looks like a list, so reaching
   * here means the page really is about a single item — and plenty of shops
   * serve those from paths like `/catalogue/<slug>/`, which the collection
   * rule below would otherwise claim.
   */
  if (product?.priceCents !== undefined) return 'PRODUCT';

  for (const rule of PATH_RULES) {
    if (rule.pattern.test(pathname)) return rule.type;
  }

  if (pathname === '/' || pathname === '') return 'HOME';

  const heading = `${title ?? ''} ${text.slice(0, 400)}`.toLowerCase();
  if (/frequently asked|faq/.test(heading)) return 'FAQ';
  if (/shipping|delivery/.test(heading)) return 'SHIPPING';
  if (/returns?|refunds?/.test(heading)) return 'RETURNS';
  if (/contact/.test(heading)) return 'CONTACT';
  if (/about us|our story/.test(heading)) return 'ABOUT';

  return 'OTHER';
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function textOf(node: HTMLElement | null | undefined): string | undefined {
  const text = node?.text?.trim().replace(/\s+/g, ' ');
  return text === undefined || text === '' ? undefined : text.slice(0, 1_000);
}

function resolveMaybe(href: string | undefined | null, base: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

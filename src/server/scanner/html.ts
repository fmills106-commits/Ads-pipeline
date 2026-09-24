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
  images: Array<{ url: string; altText?: string; isPrimary: boolean }>;
  statedOffers: StatedOffer[];
  callsToAction: string[];
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
  /** Present when the page looks like a product page. */
  product: ExtractedProduct | null;
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
  const product = extractProduct({ root, jsonLd, openGraph, text, pageUrl });

  const pageType = classifyPageType({ pageUrl, title, text, product, jsonLd });

  return {
    title,
    metaDescription,
    canonicalUrl,
    pageType,
    text,
    structuredData: { jsonLd, openGraph, microdata },
    links,
    business,
    product,
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
    /\badd to (?:cart|bag|basket)\b/i.test(text) ||
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

/** Whether a URL is a site's front page. */
function isSiteRoot(pageUrl: string): boolean {
  try {
    const { pathname } = new URL(pageUrl);
    return pathname === '/' || pathname === '' || /^\/index\.\w+$/i.test(pathname);
  } catch {
    return false;
  }
}

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

  return (text.match(/\badd to (?:cart|bag|basket)\b/gi) ?? []).length > 2;
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

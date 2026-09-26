import { createHash } from 'node:crypto';
import type { Availability, ExtractionMethod, Prisma, Product } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { BusinessContext } from '@/server/tenancy/context';
import type { CrawledPage, CrawlResult } from './crawler';
import type { ExtractedValue } from './html';

/**
 * Storing what the scan found.
 *
 * Two invariants this module exists to hold:
 *
 *  1. **Provenance or nothing.** A fact row cannot be written without a source
 *     URL, an extraction method and a confidence, because the whole product
 *     rests on being able to say where a claim came from.
 *  2. **History is never overwritten.** A product whose price changed gets a
 *     new version row; the previous value stays readable. A product that has
 *     disappeared is marked `removedAt`, not deleted, because campaigns may
 *     still reference it.
 */

export interface PersistResult {
  websiteId: string;
  pagesStored: number;
  productsFound: number;
  productsNew: number;
  productsChanged: number;
  productsRemoved: number;
  factsExtracted: number;
  changeSummary: ChangeSummary;
}

export interface ChangeSummary {
  isFirstScan: boolean;
  newProducts: Array<{ name: string; url: string }>;
  removedProducts: Array<{ name: string; url: string }>;
  priceChanges: Array<{
    name: string;
    url: string;
    fromCents: number | null;
    toCents: number | null;
  }>;
  availabilityChanges: Array<{ name: string; url: string; from: string; to: string }>;
}

/** Stable hash of the fields that matter for change detection. */
function hashOf(parts: Array<string | number | null | undefined>): string {
  return createHash('sha256')
    .update(parts.map((part) => String(part ?? '')).join('\u0000'))
    .digest('hex');
}

/** A fact row waiting to be written, with its provenance already attached. */
interface PendingFact {
  key: string;
  value: string;
  sourceUrl: string;
  sourceExcerpt: string | null;
  method: ExtractionMethod;
  confidence: number;
}

function factFrom(
  key: string,
  extracted: ExtractedValue | undefined,
  sourceUrl: string,
): PendingFact | null {
  if (!extracted) return null;
  const value = String(extracted.value).trim();
  if (value === '') return null;

  return {
    key,
    value: value.slice(0, 2_000),
    sourceUrl,
    sourceExcerpt: extracted.excerpt ?? null,
    method: extracted.method,
    confidence: extracted.confidence,
  };
}

export async function persistScan(
  context: BusinessContext,
  scanRunId: string,
  crawl: CrawlResult,
  db: Db = prisma,
): Promise<PersistResult> {
  const log = logger().child({ businessId: context.businessId, scanRunId });

  // --- website row ------------------------------------------------------
  const website = await db.website.upsert({
    where: { businessId_rootUrl: { businessId: context.businessId, rootUrl: crawl.rootUrl } },
    create: {
      businessId: context.businessId,
      rootUrl: crawl.rootUrl,
      resolvedRootUrl: crawl.resolvedRootUrl,
      robotsTxt: crawl.robotsTxt,
      robotsFetchedAt: crawl.robotsTxt === null ? null : new Date(),
      sitemapUrls: crawl.sitemapUrls,
      lastScanAt: new Date(),
      lastScanRunId: scanRunId,
    },
    update: {
      resolvedRootUrl: crawl.resolvedRootUrl,
      robotsTxt: crawl.robotsTxt,
      robotsFetchedAt: crawl.robotsTxt === null ? null : new Date(),
      sitemapUrls: crawl.sitemapUrls,
      lastScanAt: new Date(),
      lastScanRunId: scanRunId,
    },
  });

  await db.scanRun.update({ where: { id: scanRunId }, data: { websiteId: website.id } });

  // What we knew before this scan, for change detection.
  const previousProducts = await db.product.findMany({
    where: { websiteId: website.id, removedAt: null },
  });
  const previousByUrl = new Map(previousProducts.map((product) => [product.productUrl, product]));
  const isFirstScan = previousProducts.length === 0;

  const changeSummary: ChangeSummary = {
    isFirstScan,
    newProducts: [],
    removedProducts: [],
    priceChanges: [],
    availabilityChanges: [],
  };

  // --- pages ------------------------------------------------------------
  let pagesStored = 0;
  for (const page of crawl.pages) {
    await persistPage(context, website.id, page, db);
    pagesStored += 1;
  }

  // --- business facts ---------------------------------------------------
  const businessFacts = collectBusinessFacts(crawl);
  let factsExtracted = await writeBusinessFacts(context, scanRunId, businessFacts, db);

  // --- products ---------------------------------------------------------
  let productsNew = 0;
  let productsChanged = 0;
  const seenProductUrls = new Set<string>();

  for (const page of crawl.pages) {
    for (const extracted of page.extraction.products) {
      if (!extracted.name) continue;

      /*
       * A product's identity is the URL it was found at, which is what keeps
       * its price history attached to it from one scan to the next.
       *
       * A page offering several products needs more than its own URL to tell
       * them apart, so each carries a short identifier from the page and it
       * becomes a fragment. A page about one product keeps the bare URL, so
       * nothing recorded before this existed loses its history.
       */
      const productUrl = extracted.pageAnchor
        ? `${page.finalUrl}#${extracted.pageAnchor}`
        : page.finalUrl;
      if (seenProductUrls.has(productUrl)) continue;
      seenProductUrls.add(productUrl);

      const name = String(extracted.name.value).slice(0, 500);
      const priceCents = extracted.priceCents?.value ?? null;
      const comparePriceCents = extracted.comparePriceCents?.value ?? null;
      const currency = extracted.currency?.value ?? context.business.currency;
      const availability: Availability = extracted.availability?.value ?? 'UNKNOWN';
      const description = extracted.description?.value ?? null;
      const sku = extracted.sku?.value ?? null;
      const brand = extracted.brand?.value ?? null;
      const category = extracted.category?.value ?? null;

      const contentHash = hashOf([
        name,
        description,
        priceCents,
        comparePriceCents,
        currency,
        availability,
        sku,
      ]);

      const previous = previousByUrl.get(productUrl);
      // Cast at the boundary: these are plain data objects, but Prisma's
      // InputJsonValue does not accept a typed interface without an index
      // signature, and widening every extraction type to satisfy it would be
      // worse than one explicit conversion here.
      const snapshot = {
        name,
        description,
        priceCents,
        comparePriceCents,
        currency,
        availability,
        sku,
        brand,
        category,
        statedOffers: extracted.statedOffers,
        callsToAction: extracted.callsToAction,
      } as unknown as Prisma.InputJsonValue;

      const product = await db.product.upsert({
        where: { websiteId_productUrl: { websiteId: website.id, productUrl } },
        create: {
          businessId: context.businessId,
          websiteId: website.id,
          productUrl,
          name,
          description,
          priceCents,
          comparePriceCents,
          currency,
          availability,
          sku,
          brand,
          category,
          tags: [],
          statedOffers: extracted.statedOffers as unknown as Prisma.InputJsonValue,
          callsToAction: extracted.callsToAction,
          contentHash,
          lastSeenAt: new Date(),
        },
        update: {
          name,
          description,
          priceCents,
          comparePriceCents,
          currency,
          availability,
          sku,
          brand,
          category,
          statedOffers: extracted.statedOffers as unknown as Prisma.InputJsonValue,
          callsToAction: extracted.callsToAction,
          contentHash,
          lastSeenAt: new Date(),
          // A product that came back after being gone is no longer removed.
          removedAt: null,
        },
      });

      // --- versioning: only when something actually changed ---------------
      if (!previous) {
        productsNew += 1;
        await writeVersion(product.id, 1, snapshot, [], scanRunId, db);
        changeSummary.newProducts.push({ name, url: productUrl });
      } else if (previous.contentHash !== contentHash) {
        productsChanged += 1;

        const changedFields = diffProduct(previous, {
          name,
          description,
          priceCents,
          comparePriceCents,
          availability,
          sku,
        });

        const lastVersion = await db.productVersion.findFirst({
          where: { productId: product.id },
          orderBy: { versionNumber: 'desc' },
          select: { versionNumber: true },
        });
        await writeVersion(
          product.id,
          (lastVersion?.versionNumber ?? 0) + 1,
          snapshot,
          changedFields,
          scanRunId,
          db,
        );

        if (changedFields.includes('priceCents')) {
          changeSummary.priceChanges.push({
            name,
            url: productUrl,
            fromCents: previous.priceCents,
            toCents: priceCents,
          });
        }
        if (changedFields.includes('availability')) {
          changeSummary.availabilityChanges.push({
            name,
            url: productUrl,
            from: previous.availability,
            to: availability,
          });
        }
      }

      // --- images ---------------------------------------------------------
      for (const [index, image] of extracted.images.slice(0, 12).entries()) {
        await db.productImage
          .upsert({
            where: { productId_sourceUrl: { productId: product.id, sourceUrl: image.url } },
            create: {
              productId: product.id,
              sourceUrl: image.url,
              altText: image.altText ?? null,
              isPrimary: index === 0,
              position: index,
            },
            update: { altText: image.altText ?? null, position: index },
          })
          .catch(() => undefined); // A malformed image URL must not fail the scan.
      }

      // --- product facts ---------------------------------------------------
      const productFacts: PendingFact[] = [];
      const push = (fact: PendingFact | null) => {
        if (fact) productFacts.push(fact);
      };

      push(factFrom('product.name', extracted.name, productUrl));
      push(factFrom('product.description', extracted.description, productUrl));
      push(factFrom('product.sku', extracted.sku, productUrl));
      push(factFrom('product.brand', extracted.brand, productUrl));
      push(factFrom('product.category', extracted.category, productUrl));
      if (extracted.priceCents) {
        push(
          factFrom(
            'product.price',
            {
              value: `${(extracted.priceCents.value / 100).toFixed(2)} ${currency}`,
              method: extracted.priceCents.method,
              confidence: extracted.priceCents.confidence,
              ...(extracted.priceCents.excerpt === undefined
                ? {}
                : { excerpt: extracted.priceCents.excerpt }),
            },
            productUrl,
          ),
        );
      }
      if (extracted.availability) {
        push(
          factFrom(
            'product.availability',
            {
              value: extracted.availability.value,
              method: extracted.availability.method,
              confidence: extracted.availability.confidence,
            },
            productUrl,
          ),
        );
      }
      for (const offer of extracted.statedOffers) {
        productFacts.push({
          key: `offer.${offer.kind}`,
          value: offer.sourceText,
          sourceUrl: productUrl,
          sourceExcerpt: offer.sourceText,
          // An offer is only ever recorded because the page literally said it.
          method: 'TEXT_PATTERN',
          confidence: 0.6,
        });
      }
      for (const cta of extracted.callsToAction) {
        productFacts.push({
          key: 'cta',
          value: cta,
          sourceUrl: productUrl,
          sourceExcerpt: cta,
          method: 'HTML',
          confidence: 0.7,
        });
      }

      factsExtracted += await writeProductFacts(product.id, scanRunId, productFacts, db);
    }
  }

  // --- products that disappeared ----------------------------------------
  let productsRemoved = 0;
  // Only conclude "removed" from a scan that actually finished; a crawl that
  // hit its page limit has simply not looked everywhere.
  if (crawl.stopReason === 'completed') {
    for (const [url, previous] of previousByUrl) {
      if (seenProductUrls.has(url)) continue;
      await db.product.update({ where: { id: previous.id }, data: { removedAt: new Date() } });
      productsRemoved += 1;
      changeSummary.removedProducts.push({ name: previous.name, url });
    }
  }

  log.info('Scan persisted', {
    pagesStored,
    products: seenProductUrls.size,
    productsNew,
    productsChanged,
    productsRemoved,
    factsExtracted,
  });

  return {
    websiteId: website.id,
    pagesStored,
    productsFound: seenProductUrls.size,
    productsNew,
    productsChanged,
    productsRemoved,
    factsExtracted,
    changeSummary,
  };
}

async function persistPage(
  context: BusinessContext,
  websiteId: string,
  page: CrawledPage,
  db: Db,
): Promise<void> {
  const { extraction } = page;
  const contentHash = hashOf([
    extraction.title,
    extraction.metaDescription,
    extraction.text.slice(0, 10_000),
    JSON.stringify(extraction.structuredData.jsonLd).slice(0, 10_000),
  ]);

  await db.websitePage.upsert({
    where: { websiteId_url: { websiteId, url: page.url } },
    create: {
      businessId: context.businessId,
      websiteId,
      url: page.url,
      finalUrl: page.finalUrl === page.url ? null : page.finalUrl,
      pageType: extraction.pageType,
      httpStatus: page.status,
      title: extraction.title?.slice(0, 500) ?? null,
      metaDescription: extraction.metaDescription?.slice(0, 1_000) ?? null,
      extractedText: extraction.text,
      imageAlts: extraction.imageAlts,
      structuredData: extraction.structuredData as unknown as Prisma.InputJsonValue,
      contentHash,
      outboundLinkCount: extraction.links.length,
    },
    update: {
      finalUrl: page.finalUrl === page.url ? null : page.finalUrl,
      pageType: extraction.pageType,
      httpStatus: page.status,
      title: extraction.title?.slice(0, 500) ?? null,
      metaDescription: extraction.metaDescription?.slice(0, 1_000) ?? null,
      extractedText: extraction.text,
      imageAlts: extraction.imageAlts,
      structuredData: extraction.structuredData as unknown as Prisma.InputJsonValue,
      contentHash,
      outboundLinkCount: extraction.links.length,
      fetchedAt: new Date(),
    },
  });
}

/** Business-level facts, taken from the highest-confidence page that has them. */
function collectBusinessFacts(crawl: CrawlResult): PendingFact[] {
  const byKey = new Map<string, PendingFact>();

  const consider = (fact: PendingFact | null): void => {
    if (!fact) return;
    const existing = byKey.get(fact.key);
    if (!existing || fact.confidence > existing.confidence) byKey.set(fact.key, fact);
  };

  for (const page of crawl.pages) {
    const { business } = page.extraction;
    const source = page.finalUrl;

    consider(factFrom('business.name', business.name, source));
    consider(factFrom('business.description', business.description, source));
    consider(factFrom('contact.email', business.email, source));
    consider(factFrom('contact.phone', business.phone, source));
    consider(factFrom('contact.address', business.address, source));

    // Policy pages are facts in themselves: knowing a returns policy exists,
    // and where, is what later phases need to avoid inventing one.
    const policyKey: Record<string, string | undefined> = {
      SHIPPING: 'policy.shipping_url',
      RETURNS: 'policy.returns_url',
      FAQ: 'policy.faq_url',
      CONTACT: 'page.contact_url',
      ABOUT: 'page.about_url',
    };
    const key = policyKey[page.extraction.pageType];
    if (key) {
      consider({
        key,
        value: source,
        sourceUrl: source,
        sourceExcerpt: page.extraction.title ?? null,
        method: 'HTML',
        confidence: 0.75,
      });
    }
  }

  // Social profiles are multi-valued, so they bypass the one-per-key map.
  const socials = new Set<string>();
  for (const page of crawl.pages) {
    for (const profile of page.extraction.business.socialProfiles) socials.add(profile);
  }

  const facts = [...byKey.values()];
  for (const profile of [...socials].slice(0, 10)) {
    facts.push({
      key: 'social.profile',
      value: profile,
      sourceUrl: crawl.resolvedRootUrl,
      sourceExcerpt: null,
      method: 'HTML',
      confidence: 0.8,
    });
  }

  return facts;
}

async function writeBusinessFacts(
  context: BusinessContext,
  scanRunId: string,
  facts: PendingFact[],
  db: Db,
): Promise<number> {
  let written = 0;

  for (const fact of facts) {
    await db.businessFact
      .upsert({
        where: {
          businessId_key_value: {
            businessId: context.businessId,
            key: fact.key,
            value: fact.value,
          },
        },
        create: {
          businessId: context.businessId,
          key: fact.key,
          value: fact.value,
          sourceUrl: fact.sourceUrl,
          sourceExcerpt: fact.sourceExcerpt,
          method: fact.method,
          confidence: fact.confidence,
          scanRunId,
        },
        // Re-seeing a fact refreshes when it was last confirmed, and upgrades
        // its provenance if this scan found it by a more trustworthy route.
        update: {
          lastSeenAt: new Date(),
          sourceUrl: fact.sourceUrl,
          method: fact.method,
          confidence: fact.confidence,
          scanRunId,
        },
      })
      .then(() => {
        written += 1;
      })
      .catch(() => undefined);
  }

  return written;
}

async function writeProductFacts(
  productId: string,
  scanRunId: string,
  facts: PendingFact[],
  db: Db,
): Promise<number> {
  let written = 0;

  for (const fact of facts) {
    await db.productFact
      .upsert({
        where: { productId_key_value: { productId, key: fact.key, value: fact.value } },
        create: {
          productId,
          key: fact.key,
          value: fact.value,
          sourceUrl: fact.sourceUrl,
          sourceExcerpt: fact.sourceExcerpt,
          method: fact.method,
          confidence: fact.confidence,
          scanRunId,
        },
        update: {
          lastSeenAt: new Date(),
          method: fact.method,
          confidence: fact.confidence,
          scanRunId,
        },
      })
      .then(() => {
        written += 1;
      })
      .catch(() => undefined);
  }

  return written;
}

async function writeVersion(
  productId: string,
  versionNumber: number,
  snapshot: Prisma.InputJsonValue,
  changedFields: string[],
  scanRunId: string,
  db: Db,
): Promise<void> {
  await db.productVersion
    .create({ data: { productId, versionNumber, snapshot, changedFields, scanRunId } })
    .catch(() => undefined); // A version collision under concurrency is not fatal.
}

const VERSIONED_FIELDS = [
  'name',
  'description',
  'priceCents',
  'comparePriceCents',
  'availability',
  'sku',
] as const;

function diffProduct(
  previous: Product,
  next: Partial<Record<(typeof VERSIONED_FIELDS)[number], unknown>>,
): string[] {
  const changed: string[] = [];
  for (const field of VERSIONED_FIELDS) {
    if (!(field in next)) continue;
    if (!Object.is(previous[field], next[field])) changed.push(field);
  }
  return changed;
}

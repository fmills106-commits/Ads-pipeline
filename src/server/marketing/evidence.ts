import { prisma, type Db } from '@/lib/db';
import type { BusinessContext } from '@/server/tenancy/context';
import type { PageType, Product } from '@prisma/client';

/**
 * Everything known about a business and its products, in one place.
 *
 * This exists because of a specific failure. The scanner read eight pages of a
 * real storefront and extracted, among much else, that the product is soft
 * foam, slow-rising, and comes in twelve Halloween designs. The thing writing
 * the advertisement was handed this:
 *
 *     Full Case
 *     Price: 132.00 USD
 *     Availability: UNKNOWN
 *
 * Nothing else. Not the description — `gatherEvidence` selected that column
 * from the database and then left it out of the string it built — and none of
 * the page text, which went to the business analysis and stopped there.
 *
 * An advertising engine that reads a website and then writes from the product
 * name and price is not an advertising engine. It is a template, and what it
 * produces is the "generic stuff" an owner can spot from across the room. The
 * information was never missing; it was collected and then dropped on the
 * floor between two functions. So there is now one function, used by both, and
 * adding a field to it reaches every writer at once.
 *
 * Three rules hold everywhere in here:
 *
 *  1. **Provenance survives.** Every line says where it came from — the
 *     merchant's page, or the owner's own mouth. The writer is told not to
 *     claim anything the material does not support, and that instruction is
 *     worthless if the material arrives as an undifferentiated blob.
 *  2. **The owner outranks the page.** Where both describe a product, theirs
 *     wins: they know more about what they sell than their product page does.
 *  3. **Nothing is invented to fill a gap.** An absent description is absent,
 *     stated as such, rather than back-filled from a neighbouring paragraph
 *     that might belong to a different product.
 */

/** Page types whose words describe what is being sold. */
const INFORMATIVE_PAGES: PageType[] = ['HOME', 'ABOUT', 'PRODUCT', 'COLLECTION', 'FAQ', 'OTHER'];

const MAX_FACTS = 120;
const MAX_PRODUCTS = 40;
const MAX_PAGES = 8;
const MAX_PAGE_CHARS = 12_000;
const MAX_TOTAL_PAGE_CHARS = 30_000;

export interface EvidenceProduct {
  id: string;
  name: string;
  /** The owner's words if they gave any, else the page's. */
  description: string | null;
  descriptionSource: 'owner' | 'page' | null;
  priceCents: number | null;
  currency: string | null;
  availability: string;
  category: string | null;
  brand: string | null;
  sku: string | null;
  /** Whether the owner supplied a cost, which decides if margin is knowable. */
  costKnown: boolean;
}

export interface Evidence {
  businessName: string;
  /** What the owner told us that the site does not say. */
  ownerNotes: string | null;
  factIds: string[];
  factCount: number;
  productCount: number;

  /** Rendered blocks, ready to hand to a writer. */
  factsText: string;
  productsText: string;
  pageText: string;
  ownerNotesText: string;
}

/**
 * Gathers the dossier.
 *
 * `productId` narrows the product section to one product while leaving the
 * business-level material intact — which is what writing one advertisement
 * needs: everything about the company, and the detail of the single thing
 * being advertised.
 */
export async function gatherEvidence(
  context: BusinessContext,
  options: { productId?: string } = {},
  db: Db = prisma,
): Promise<Evidence> {
  const [facts, products, pages] = await Promise.all([
    db.businessFact.findMany({
      where: { businessId: context.businessId },
      orderBy: [{ confidence: 'desc' }, { key: 'asc' }],
      take: MAX_FACTS,
      select: { id: true, key: true, value: true, sourceUrl: true },
    }),
    db.product.findMany({
      where: {
        businessId: context.businessId,
        removedAt: null,
        ...(options.productId ? { id: options.productId } : {}),
      },
      orderBy: { lastSeenAt: 'desc' },
      take: options.productId ? 1 : MAX_PRODUCTS,
    }),
    db.websitePage.findMany({
      where: { businessId: context.businessId, pageType: { in: INFORMATIVE_PAGES } },
      orderBy: { fetchedAt: 'desc' },
      take: MAX_PAGES,
      select: { url: true, title: true, pageType: true, extractedText: true },
    }),
  ]);

  const evidenceProducts = products.map(toEvidenceProduct);

  return {
    businessName: context.business.name,
    ownerNotes: context.business.description,
    factIds: facts.map((fact) => fact.id),
    factCount: facts.length,
    productCount: evidenceProducts.length,

    factsText: facts.map((fact) => `${fact.key}: ${fact.value}`).join('\n'),
    productsText: evidenceProducts.map(renderProduct).join('\n\n'),
    pageText: renderPages(pages),
    ownerNotesText: context.business.description
      ? `The owner says, in their own words:\n${context.business.description}`
      : '',
  };
}

function toEvidenceProduct(product: Product): EvidenceProduct {
  // Rule 2: the owner outranks the page.
  const owner = product.ownerDescription?.trim();
  const page = product.description?.trim();

  return {
    id: product.id,
    name: product.name,
    description: owner || page || null,
    descriptionSource: owner ? 'owner' : page ? 'page' : null,
    priceCents: product.priceCents,
    currency: product.currency,
    availability: product.availability,
    category: product.category,
    brand: product.brand,
    sku: product.sku,
    costKnown: product.costCents !== null,
  };
}

function renderProduct(product: EvidenceProduct): string {
  const lines = [`Product: ${product.name}`];

  if (product.description) {
    // Rule 1: the writer is told whose words these are. An owner's sentence
    // may be used as a claim; a scraped one already was one.
    lines.push(
      product.descriptionSource === 'owner'
        ? `Description (from the owner): ${product.description}`
        : `Description (from the product page): ${product.description}`,
    );
  } else {
    // Rule 3: say it is missing rather than leaving a silence the writer fills.
    lines.push('Description: none given — do not invent one.');
  }

  lines.push(
    product.priceCents === null
      ? 'Price: not stated'
      : `Price: ${(product.priceCents / 100).toFixed(2)} ${product.currency ?? ''}`.trim(),
  );
  if (product.brand) lines.push(`Brand: ${product.brand}`);
  if (product.category) lines.push(`Category: ${product.category}`);
  if (product.sku) lines.push(`Reference: ${product.sku}`);
  lines.push(`Availability: ${product.availability}`);

  return lines.join('\n');
}

function renderPages(
  pages: Array<{
    url: string;
    title: string | null;
    pageType: PageType;
    extractedText: string | null;
  }>,
): string {
  const blocks: string[] = [];
  let budget = MAX_TOTAL_PAGE_CHARS;

  for (const page of pages) {
    const text = page.extractedText?.trim();
    if (!text || budget <= 0) continue;

    const slice = text.slice(0, Math.min(MAX_PAGE_CHARS, budget));
    budget -= slice.length;

    // Labelled with the page it came from, so a claim can be traced back to
    // the merchant's own words rather than arriving anonymously.
    blocks.push(`--- ${page.pageType} page: ${page.title ?? page.url}\n(${page.url})\n${slice}`);
  }

  return blocks.join('\n\n');
}

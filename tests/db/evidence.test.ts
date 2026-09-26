import { beforeEach, describe, expect, it } from 'vitest';
import type { User, Workspace } from '@prisma/client';
import { prisma } from '@/lib/db';
import { createBusiness } from '@/server/business/service';
import { setProductDetails } from '@/server/business/product-details';
import { gatherEvidence } from '@/server/marketing/evidence';
import { requireBusinessContext, requireWorkspaceContext } from '@/server/tenancy/context';
import type { BusinessContext } from '@/server/tenancy/context';
import { createTestUser, createTestWorkspace, resetDatabase } from '../helpers/db';

/**
 * What the writer is actually given.
 *
 * The failure these tests exist for: the scanner read eight pages of a real
 * storefront, including that the product is soft foam, slow-rising and comes
 * in twelve Halloween designs — and the thing writing the advertisement
 * received a name, a price and "Availability: UNKNOWN". The description was
 * selected from the database and then left out of the string; the page text
 * went to the business analysis and stopped there.
 *
 * So these assert the plumbing, not the prose: if a detail is in the database
 * and not in this dossier, no model can save the output.
 */

let user: User;
let workspace: Workspace;

beforeEach(async () => {
  await resetDatabase();
  user = await createTestUser();
  workspace = await createTestWorkspace(user);
});

async function businessWithProduct(
  options: {
    productName?: string;
    pageDescription?: string | null;
    notes?: string | null;
  } = {},
): Promise<{ context: BusinessContext; productId: string }> {
  const workspaceContext = await requireWorkspaceContext(user, workspace.id);
  const business = await createBusiness(workspaceContext, { name: 'Smooshery' });
  if (options.notes !== undefined) {
    await prisma.business.update({
      where: { id: business.id },
      data: { description: options.notes },
    });
  }

  const website = await prisma.website.create({
    data: { businessId: business.id, rootUrl: 'https://example.com' },
  });
  const product = await prisma.product.create({
    data: {
      businessId: business.id,
      websiteId: website.id,
      productUrl: 'https://example.com/#case12',
      name: options.productName ?? 'Full Case',
      description: options.pageDescription ?? null,
      priceCents: 13_200,
      currency: 'USD',
      contentHash: 'hash',
    },
  });

  // Enough facts that a real analysis would not refuse.
  for (let i = 0; i < 3; i += 1) {
    await prisma.businessFact.create({
      data: {
        businessId: business.id,
        key: `contact.detail${i}`,
        value: `value ${i}`,
        sourceUrl: 'https://example.com/',
        method: 'HTML',
        confidence: 0.8,
      },
    });
  }

  return { context: await requireBusinessContext(user, business.id), productId: product.id };
}

describe('the dossier handed to a writer', () => {
  it('includes the description the page gave, which used to be dropped', async () => {
    const { context } = await businessWithProduct({
      pageDescription: 'Soft foam squishies that rise back slowly.',
    });

    const evidence = await gatherEvidence(context);

    expect(evidence.productsText).toContain('Soft foam squishies that rise back slowly.');
    // And says whose words they are, so a claim can be traced.
    expect(evidence.productsText).toContain('from the product page');
  });

  it('prefers the owner’s words over the page’s', async () => {
    const { context, productId } = await businessWithProduct({
      pageDescription: 'A box of twelve.',
    });

    await setProductDetails(context, productId, {
      ownerDescription: 'Twelve Halloween designs, wrapped so it is a surprise.',
    });

    const evidence = await gatherEvidence(context);
    expect(evidence.productsText).toContain('Twelve Halloween designs');
    expect(evidence.productsText).toContain('from the owner');
    // The page's version does not also appear: two descriptions of one product
    // is how a writer ends up hedging between them.
    expect(evidence.productsText).not.toContain('A box of twelve.');
  });

  it('says a description is missing rather than leaving a silence', async () => {
    // A blank invites the writer to fill it. Naming the absence does not.
    const { context } = await businessWithProduct({ pageDescription: null });

    const evidence = await gatherEvidence(context);
    expect(evidence.productsText).toContain('do not invent one');
  });

  it('carries the owner’s notes about the business', async () => {
    const { context } = await businessWithProduct({
      notes: 'Mostly bought by collectors. Never say they are edible.',
    });

    const evidence = await gatherEvidence(context);
    expect(evidence.ownerNotesText).toContain('Never say they are edible');
    expect(evidence.ownerNotesText).toContain('in their own words');
  });

  it('omits the notes section entirely when there are none', async () => {
    const { context } = await businessWithProduct({ notes: null });
    expect((await gatherEvidence(context)).ownerNotesText).toBe('');
  });

  it('includes the website’s own text, labelled with the page it came from', async () => {
    const { context } = await businessWithProduct();
    const website = await prisma.website.findFirstOrThrow({
      where: { businessId: context.businessId },
    });
    await prisma.websitePage.create({
      data: {
        businessId: context.businessId,
        websiteId: website.id,
        url: 'https://example.com/',
        finalUrl: 'https://example.com/',
        pageType: 'HOME',
        title: 'Smooshery',
        extractedText: 'Soft. Slow-rising. Twelve Halloween designs to collect.',
        contentHash: 'h',
        httpStatus: 200,
      },
    });

    const evidence = await gatherEvidence(context);
    expect(evidence.pageText).toContain('Twelve Halloween designs to collect');
    expect(evidence.pageText).toContain('HOME page');
    expect(evidence.pageText).toContain('https://example.com/');
  });

  it('narrows to one product without losing the business material', async () => {
    const { context, productId } = await businessWithProduct({
      pageDescription: 'The full case.',
      notes: 'Collectors buy these.',
    });
    const website = await prisma.website.findFirstOrThrow({
      where: { businessId: context.businessId },
    });
    await prisma.product.create({
      data: {
        businessId: context.businessId,
        websiteId: website.id,
        productUrl: 'https://example.com/#single',
        name: 'Single',
        priceCents: 1_500,
        currency: 'USD',
        contentHash: 'hash2',
      },
    });

    const evidence = await gatherEvidence(context, { productId });

    expect(evidence.productCount).toBe(1);
    expect(evidence.productsText).toContain('Full Case');
    expect(evidence.productsText).not.toContain('Single');
    // Writing one advert still needs everything about the company.
    expect(evidence.ownerNotesText).toContain('Collectors buy these');
    expect(evidence.factCount).toBe(3);
  });
});

describe('what the pictures show', () => {
  /*
   * The owner's point: words alone are not enough for a physical product. The
   * cheapest version of seeing is reading what the merchant already wrote
   * about their own pictures — and the engine was discarding all of it. Twelve
   * Halloween designs were named in alt text and nowhere else.
   */
  it('carries the merchant’s own image descriptions', async () => {
    const { context } = await businessWithProduct();
    const website = await prisma.website.findFirstOrThrow({
      where: { businessId: context.businessId },
    });
    await prisma.websitePage.create({
      data: {
        businessId: context.businessId,
        websiteId: website.id,
        url: 'https://example.com/',
        finalUrl: 'https://example.com/',
        pageType: 'HOME',
        title: 'Smooshery',
        extractedText: 'Pick your pack.',
        imageAlts: [
          'Sunset Bats squishy, sealed in its wrapper',
          'Cotton Ghost squishy, sealed in its wrapper',
        ],
        contentHash: 'h',
        httpStatus: 200,
      },
    });

    const evidence = await gatherEvidence(context);

    expect(evidence.imageText).toContain('Sunset Bats');
    expect(evidence.imageText).toContain('Cotton Ghost');
  });

  it('attributes a product’s own picture to that product', async () => {
    const { context, productId } = await businessWithProduct();
    await prisma.productImage.create({
      data: {
        productId,
        sourceUrl: 'https://example.com/img/case.webp',
        altText: 'A retail display box, six wrapped designs visible',
        position: 0,
      },
    });

    const evidence = await gatherEvidence(context, { productId });

    // Named, so a writer knows which product it is evidence about.
    expect(evidence.imageText).toContain('Full Case: A retail display box');
  });

  it('says these describe pictures, not guarantees', async () => {
    const { context, productId } = await businessWithProduct();
    await prisma.productImage.create({
      data: {
        productId,
        sourceUrl: 'https://example.com/img/a.webp',
        altText: 'Sealed in its wrapper',
        position: 0,
      },
    });

    const evidence = await gatherEvidence(context, { productId });

    // A writer may say a design is called "Sunset Bats" on this evidence, and
    // must not say the product is "sealed for freshness" on it.
    expect(evidence.imageText).toMatch(/describe images, not guarantees/);
  });

  it('says whether an image is usable as an advertisement', async () => {
    /*
     * `ProductImage.width` and `.height` have existed since Phase 2 and
     * nothing ever filled them, so the engine knew every picture's address and
     * nothing about its shape. Shape is what decides whether a shop can
     * advertise at all: Meta will not take a creative below roughly 1080px on
     * its short side, and "every photograph here is 400px wide" is a finding an
     * owner can act on.
     */
    const { context, productId } = await businessWithProduct();
    await prisma.productImage.createMany({
      data: [
        {
          productId,
          sourceUrl: 'https://example.com/img/big.webp',
          altText: 'The display box',
          width: 1200,
          height: 1200,
          position: 0,
        },
        {
          productId,
          sourceUrl: 'https://example.com/img/small.webp',
          altText: 'A thumbnail',
          width: 320,
          height: 240,
          position: 1,
        },
      ],
    });

    const evidence = await gatherEvidence(context, { productId });

    expect(evidence.imageText).toContain('1200×1200, square');
    expect(evidence.imageText).toContain('320×240, landscape, far too small for an ad');
  });

  it('leaves an undeclared size unknown rather than guessing it', async () => {
    // Downloading every image to measure it is bandwidth a scan need not
    // spend, and a guessed dimension would be a fact with nothing behind it.
    const { context, productId } = await businessWithProduct();
    await prisma.productImage.create({
      data: {
        productId,
        sourceUrl: 'https://example.com/img/unknown.webp',
        altText: 'No size declared',
        position: 0,
      },
    });

    const evidence = await gatherEvidence(context, { productId });
    expect(evidence.imageText).toContain('No size declared');
    expect(evidence.imageText).not.toMatch(/\d+×\d+/);
  });

  it('offers the biggest pictures to a writer that can see', async () => {
    const { context, productId } = await businessWithProduct();
    await prisma.productImage.createMany({
      data: [
        {
          productId,
          sourceUrl: 'https://example.com/img/badge.webp',
          width: 48,
          height: 48,
          position: 0,
        },
        {
          productId,
          sourceUrl: 'https://example.com/img/hero.webp',
          width: 1200,
          height: 1200,
          position: 1,
        },
        {
          productId,
          sourceUrl: 'https://example.com/img/side.webp',
          width: 800,
          height: 800,
          position: 2,
        },
      ],
    });

    const evidence = await gatherEvidence(context, { productId });

    // Biggest first, because the largest image on a product page is almost
    // always the product. The 48×48 is a payment icon or a flag, and showing it
    // buys a confident description of a padlock.
    expect(evidence.imageUrls).toEqual([
      'https://example.com/img/hero.webp',
      'https://example.com/img/side.webp',
    ]);
  });

  it('shows at most three, because each one is paid for', async () => {
    const { context, productId } = await businessWithProduct();
    await prisma.productImage.createMany({
      data: Array.from({ length: 6 }, (_, index) => ({
        productId,
        sourceUrl: `https://example.com/img/${index}.webp`,
        width: 1000 - index,
        height: 1000,
        position: index,
      })),
    });

    const evidence = await gatherEvidence(context, { productId });
    expect(evidence.imageUrls).toHaveLength(3);
  });

  it('offers none when the dossier covers the whole catalogue', async () => {
    /*
     * A picture is evidence about the thing in it. Handed a mixed set from every
     * product, a writer cannot tell which is which and will describe the wrong
     * one with total confidence — so the pictures travel only with a
     * single-product request. The alt text above still covers the catalogue.
     */
    const { context, productId } = await businessWithProduct();
    await prisma.productImage.create({
      data: {
        productId,
        sourceUrl: 'https://example.com/img/hero.webp',
        width: 1200,
        height: 1200,
        position: 0,
      },
    });

    expect((await gatherEvidence(context)).imageUrls).toEqual([]);
    expect((await gatherEvidence(context, { productId })).imageUrls).toHaveLength(1);
  });

  it('is empty when the site describes none of its pictures', async () => {
    const { context } = await businessWithProduct();
    expect((await gatherEvidence(context)).imageText).toBe('');
  });
});

describe('setProductDetails', () => {
  it('records the cost, which makes margin knowable', async () => {
    const { context, productId } = await businessWithProduct();

    expect((await gatherEvidence(context, { productId })).productsText).toBeTruthy();
    const updated = await setProductDetails(context, productId, { costCents: 450 });

    expect(updated.costCents).toBe(450);
  });

  it('keeps the page’s description intact underneath', async () => {
    // A rescan overwrites `description`; it must never touch the owner's.
    const { context, productId } = await businessWithProduct({
      pageDescription: 'What the page said.',
    });

    await setProductDetails(context, productId, { ownerDescription: 'What the owner said.' });

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.description).toBe('What the page said.');
    expect(product.ownerDescription).toBe('What the owner said.');
  });

  it('clears the owner’s description on an empty string, falling back to the page', async () => {
    const { context, productId } = await businessWithProduct({
      pageDescription: 'What the page said.',
    });
    await setProductDetails(context, productId, { ownerDescription: 'Mine.' });

    await setProductDetails(context, productId, { ownerDescription: '' });

    const evidence = await gatherEvidence(context, { productId });
    expect(evidence.productsText).toContain('What the page said.');
    expect(evidence.productsText).toContain('from the product page');
  });

  it('refuses a product belonging to someone else, as a 404', async () => {
    // Not a 403: a different answer would confirm that the product exists.
    const mine = await businessWithProduct();
    const otherUser = await createTestUser({ email: 'other@example.com' });
    const otherWorkspace = await createTestWorkspace(otherUser);
    const otherWorkspaceContext = await requireWorkspaceContext(otherUser, otherWorkspace.id);
    const otherBusiness = await createBusiness(otherWorkspaceContext, { name: 'Theirs' });
    const otherContext = await requireBusinessContext(otherUser, otherBusiness.id);

    await expect(
      setProductDetails(otherContext, mine.productId, { ownerDescription: 'mine now' }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a cost that is not a usable amount', async () => {
    const { context, productId } = await businessWithProduct();
    for (const bad of [-1, 1.5, 200_000_000]) {
      await expect(setProductDetails(context, productId, { costCents: bad })).rejects.toMatchObject(
        { code: 'VALIDATION_ERROR' },
      );
    }
  });

  it('records the edit in the audit log', async () => {
    const { context, productId } = await businessWithProduct();

    await setProductDetails(context, productId, { ownerDescription: 'Mine.', costCents: 450 });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { businessId: context.businessId, action: 'product.details_edited' },
    });
    expect(entry.actorId).toBe(context.user.id);
    expect(entry.newValue).toMatchObject({ ownerDescription: 'Mine.', costCents: 450 });
  });
});

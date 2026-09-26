import type { Product } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { conflict, validationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { recordActivity } from '@/server/activity/feed';
import { AUDIT_ACTIONS, recordAudit } from '@/server/audit/log';
import { isPaused } from '@/server/business/pause';
import type { BusinessContext } from '@/server/tenancy/context';
import { generate } from './ai';
import { checkClaims, type ClaimEvidence, type ClaimViolation } from './claims';
import { activeOffers } from './offers';
import { adCopySetSchema, strategySetSchema } from './schemas';
import { gatherEvidence } from './evidence';

/**
 * Strategies and ad copy.
 *
 * The ordering here is the point: a strategy is a hypothesis about *how* to
 * advertise something, and copy is an attempt to execute one. Generating copy
 * without a strategy would produce sentences nobody could later explain, and
 * Phase 8 could not run an experiment against it because there would be no
 * stated assumption to test.
 *
 * Copy is checked before it is stored, not after. A rejected variant is
 * recorded in the log and discarded — storing it as a draft would mean a
 * misleading claim sitting one careless click away from an ad account.
 */

export interface StrategyResult {
  created: number;
  decisionId: string;
  simulated: boolean;
}

export async function generateStrategies(
  context: BusinessContext,
  productId: string,
  db: Db = prisma,
): Promise<StrategyResult> {
  requireRunnable(context);

  const product = await requireProduct(context, productId, db);
  const profile = await db.businessProfile.findUnique({
    where: { businessId: context.businessId },
  });

  if (!profile) {
    throw validationError('Business has not been analysed yet', {
      publicMessage: 'We need to understand your business first. Press “Understand my business”.',
    });
  }

  const facts = await db.productFact.findMany({
    where: { productId: product.id },
    orderBy: { confidence: 'desc' },
    take: 30,
    select: { id: true, key: true, value: true },
  });

  const evidence = await gatherEvidence(context, { productId: product.id }, db);

  const result = await generate({
    context,
    task: 'strategy.generate',
    instruction: [
      'Propose distinct ways to advertise this one product.',
      'Each needs a hypothesis about why it might work, the assumptions behind it,',
      'and what an experiment should vary to test it.',
      'Do not assign scores or predict performance — nothing has been measured yet.',
      'Use only the material supplied; invent no features, prices or claims.',
      'The website text is the merchant\u2019s own words about what they sell:',
      'draw the specifics from it rather than writing around the product name.',
    ].join(' '),
    data: {
      productName: product.name,
      productDetails: describeProduct(product),
      productFacts: facts.map((fact) => `${fact.key}: ${fact.value}`).join('\n'),
      businessVoice: `${profile.valueProposition}\nVoice: ${profile.brandVoice}`,
      /*
       * The whole point of the dossier reaching here. Without these three, a
       * strategy for "Full Case" was written from a name, a price and an
       * availability — which is how you get "A problem/solution angle may suit
       * Full Case" instead of anything about what is in the box.
       */
      ownerNotes: evidence.ownerNotesText,
      businessFacts: evidence.factsText,
      websiteText: evidence.pageText,
    },
    schema: strategySetSchema,
    inputSummary: `Product "${product.name}" with ${facts.length} verified facts`,
    factIds: facts.map((fact) => fact.id),
    db,
  });

  // Replace rather than accumulate: five contradictory strategies for one
  // product, all current, is worse than three that agree.
  await db.marketingStrategy.updateMany({
    where: { businessId: context.businessId, productId: product.id, archivedAt: null },
    data: { archivedAt: new Date() },
  });

  const created = await db.marketingStrategy.createMany({
    data: result.value.strategies.map((strategy) => ({
      businessId: context.businessId,
      productId: product.id,
      angle: strategy.angle,
      hypothesis: strategy.hypothesis,
      hook: strategy.hook,
      suggestedCta: strategy.suggestedCta,
      assumptions: strategy.assumptions,
      testingVariables: strategy.testingVariables,
      aiDecisionId: result.decisionId,
    })),
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: context.businessId,
      actorType: 'AI',
      action: AUDIT_ACTIONS.strategiesGenerated,
      objectType: 'Product',
      objectId: product.id,
      newValue: {
        count: created.count,
        decisionId: result.decisionId,
        simulated: result.simulated,
      },
    },
    db,
  );

  await recordActivity(
    context,
    {
      kind: 'strategiesGenerated',
      message: `Worked out ${created.count} ${created.count === 1 ? 'way' : 'ways'} to advertise ${product.name}.`,
      detail: { productId: product.id, count: created.count },
    },
    db,
  );

  return { created: created.count, decisionId: result.decisionId, simulated: result.simulated };
}

export interface CopyResult {
  created: number;
  rejected: Array<{ headline: string; violations: ClaimViolation[] }>;
  decisionId: string;
  simulated: boolean;
}

/**
 * Writes ad copy for one strategy, and refuses to store what it cannot stand
 * behind.
 */
export async function generateAdCopy(
  context: BusinessContext,
  strategyId: string,
  db: Db = prisma,
): Promise<CopyResult> {
  requireRunnable(context);

  const strategy = await db.marketingStrategy.findFirst({
    where: { id: strategyId, businessId: context.businessId },
    include: { product: true },
  });
  if (!strategy?.product) throw validationError('Strategy not found');

  const product = strategy.product;
  const [profile, offers, facts, page] = await Promise.all([
    db.businessProfile.findUnique({ where: { businessId: context.businessId } }),
    activeOffers(context, new Date(), db),
    db.productFact.findMany({
      where: { productId: product.id },
      take: 30,
      select: { id: true, key: true, value: true },
    }),
    db.websitePage.findFirst({
      where: { businessId: context.businessId, url: product.productUrl },
      select: { extractedText: true },
    }),
  ]);

  // Only an offer for *this* product may be mentioned in its copy.
  const offer = offers.find((candidate) => candidate.productId === product.id) ?? null;

  const dossier = await gatherEvidence(context, { productId: product.id }, db);

  const result = await generate({
    context,
    task: 'copy.generate',
    instruction: [
      'Write ad variants for this product using the angle supplied.',
      'Every factual statement must come from the material given.',
      'The website text is the merchant\u2019s own description of what they',
      'sell: take the concrete details from it — what the thing is made of,',
      'what it does, what comes in it — rather than writing around the name.',
      'Do not state a price unless it is supplied, do not mention a discount',
      'unless an approved offer is supplied, and make no claim about awards,',
      'ratings, stock levels, deadlines, health or income.',
    ].join(' '),
    data: {
      productName: product.name,
      productDetails: describeProduct(product),
      angle: `${strategy.angle}: ${strategy.hypothesis}`,
      hook: strategy.hook,
      approvedOffer: offer
        ? `${offer.type} ${offer.value ?? ''} — ${offer.rationale}`
        : 'none — do not mention any discount',
      businessVoice: profile?.brandVoice ?? 'plain and factual',
      /*
       * The site's own words, and the owner's.
       *
       * These were already being fetched here — and used only to *police* the
       * result: `buildEvidence` below checks the copy's claims against the
       * page. So the page decided what the writer was not allowed to say
       * while never telling it what there was to say. That is how you get an
       * advertisement for a box of Halloween squishies that reads "Full Case.
       * See the details and decide for yourself."
       */
      ownerNotes: dossier.ownerNotesText,
      businessFacts: dossier.factsText,
      websiteText: dossier.pageText,
    },
    schema: adCopySetSchema,
    inputSummary: `Copy for "${product.name}" using the ${strategy.angle} angle`,
    factIds: facts.map((fact) => fact.id),
    db,
  });

  const evidence = buildEvidence(product, offer, facts, page?.extractedText ?? '', profile);

  const accepted: typeof result.value.variants = [];
  const rejected: CopyResult['rejected'] = [];

  for (const variant of result.value.variants) {
    const check = checkClaims(variant, evidence);
    if (check.ok) accepted.push(variant);
    else rejected.push({ headline: variant.headline, violations: check.violations });
  }

  if (rejected.length > 0) {
    // Worth a log line at warn: repeated rejections mean the instruction or
    // the provider needs attention, not that the checker is being fussy.
    logger().warn('Ad copy rejected by the claim check', {
      businessId: context.businessId,
      productId: product.id,
      rejected: rejected.map((entry) => entry.violations.map((v) => v.rule)).flat(),
    });
  }

  /*
   * Replace this strategy's previous drafts rather than adding to them.
   * Writing ads twice should give a fresh set, not two sets side by side with
   * no indication of which is current. Anything already approved is left
   * alone — that was a decision someone made.
   */
  await db.adCopy.deleteMany({
    where: { businessId: context.businessId, strategyId: strategy.id, status: 'DRAFT' },
  });

  const created = await db.adCopy.createMany({
    data: accepted.map((variant, index) => ({
      businessId: context.businessId,
      productId: product.id,
      strategyId: strategy.id,
      offerId: offer?.id ?? null,
      primaryText: variant.primaryText,
      headline: variant.headline,
      description: variant.description,
      cta: variant.cta,
      variantLabel: String.fromCharCode(65 + index),
      aiDecisionId: result.decisionId,
    })),
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: context.businessId,
      actorType: 'AI',
      action: AUDIT_ACTIONS.adCopyGenerated,
      objectType: 'MarketingStrategy',
      objectId: strategy.id,
      newValue: {
        accepted: created.count,
        rejected: rejected.length,
        decisionId: result.decisionId,
      },
    },
    db,
  );

  await recordActivity(
    context,
    {
      kind: 'adCopyReady',
      message: copyMessage(created.count, rejected.length, product.name),
      ...(created.count === 0 ? { needsAttention: true } : {}),
      detail: { productId: product.id, accepted: created.count, rejected: rejected.length },
    },
    db,
  );

  return {
    created: created.count,
    rejected,
    decisionId: result.decisionId,
    simulated: result.simulated,
  };
}

/**
 * What the owner is told when the checker refused something.
 *
 * Told, not hidden. A quiet "3 ads written" when two were thrown out would
 * conceal exactly the fact that matters — that something tried to claim more
 * than the website supports.
 */
function copyMessage(accepted: number, rejected: number, productName: string): string {
  if (accepted === 0) {
    return `Could not write usable ads for ${productName}: every draft made a claim your website does not support. Nothing has been saved.`;
  }
  if (rejected > 0) {
    return `Wrote ${accepted} ${accepted === 1 ? 'ad' : 'ads'} for ${productName}. ${rejected} ${rejected === 1 ? 'draft was' : 'drafts were'} thrown out for claiming more than your site says.`;
  }
  return `Wrote ${accepted} ${accepted === 1 ? 'ad' : 'ads'} for ${productName}.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireRunnable(context: BusinessContext): void {
  if (isPaused(context.business)) {
    throw conflict('Everything is paused for this business', {
      publicMessage: 'Everything is paused. Resume first, and we can carry on.',
    });
  }
}

async function requireProduct(
  context: BusinessContext,
  productId: string,
  db: Db,
): Promise<Product> {
  const product = await db.product.findFirst({
    where: { id: productId, businessId: context.businessId, removedAt: null },
  });
  if (!product) throw validationError('Product not found');
  return product;
}

/** The product, as the model is allowed to see it: stated values only. */
function describeProduct(product: Product): string {
  return [
    product.name,
    product.description ?? '',
    product.priceCents === null
      ? 'No price stated'
      : `Price: ${(product.priceCents / 100).toFixed(2)} ${product.currency ?? ''}`,
    product.brand ? `Brand: ${product.brand}` : '',
    product.category ? `Category: ${product.category}` : '',
    `Availability: ${product.availability}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Assembles what the merchant's own site supports.
 *
 * The discount allow-list is the notable part: a percentage is permitted only
 * if an approved offer carries it or the page itself advertises it. Anything
 * else the model writes about a sale is unsupported by definition.
 */
function buildEvidence(
  product: Product,
  offer: { type: string; value: number | null } | null,
  facts: Array<{ key: string; value: string }>,
  pageText: string,
  profile: { restrictions: string[] } | null,
): ClaimEvidence {
  const statedPriceCents = [product.priceCents, product.comparePriceCents].filter(
    (value): value is number => typeof value === 'number',
  );

  const statedOffers = Array.isArray(product.statedOffers) ? product.statedOffers : [];
  const pageDiscounts = statedOffers.flatMap((entry) =>
    typeof entry === 'object' && entry !== null && 'kind' in entry && 'value' in entry
      ? [(entry as { value?: unknown }).value]
      : [],
  );

  const allowedDiscountPercents = [
    ...(offer?.type === 'PERCENT_OFF' && typeof offer.value === 'number' ? [offer.value] : []),
    ...pageDiscounts.filter((value): value is number => typeof value === 'number'),
  ];

  return {
    statedPriceCents,
    currency: product.currency ?? 'USD',
    allowedDiscountPercents,
    verifiedText: [
      product.name,
      product.description ?? '',
      facts.map((fact) => fact.value).join('\n'),
      pageText,
    ].join('\n'),
    restrictions: profile?.restrictions ?? [],
    hasActiveOffer: offer !== null,
  };
}

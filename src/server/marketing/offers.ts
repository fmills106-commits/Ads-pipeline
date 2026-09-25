import type { Offer, OfferRules, OfferType, Product } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { conflict, validationError } from '@/lib/errors';
import { recordActivity } from '@/server/activity/feed';
import { AUDIT_ACTIONS, recordAudit } from '@/server/audit/log';
import { isPaused } from '@/server/business/pause';
import type { BusinessContext } from '@/server/tenancy/context';

/**
 * The offer engine.
 *
 * This module deliberately contains no AI call. Working out what a 15% discount
 * does to a price is arithmetic, and arithmetic a language model performs is
 * arithmetic nobody checked. The engine's judgement is confined to which kinds
 * of offer suit a product; every number in the result is computed here from a
 * price the merchant's own website states.
 *
 * The rules it will not break, in order of how expensive breaking them is:
 *
 *  1. **It never invents a cost.** A margin is calculated only where the
 *     merchant supplied `costCents`. Otherwise `marginKnown` is false and the
 *     UI says the margin is unknown. An estimated margin is a number someone
 *     would discount against.
 *  2. **It never exceeds the merchant's ceiling.** `OfferRules` is a
 *     constraint, not a suggestion, and a proposal outside it is not generated
 *     rather than generated and flagged.
 *  3. **It never discounts a product it cannot price.** No stated price means
 *     no proposal.
 *  4. **It never proposes for an unavailable product**, because advertising
 *     something nobody can buy is the specific failure §"never advertise an
 *     unavailable product" names.
 */

export interface OfferProposal {
  productId: string;
  productName: string;
  type: OfferType;
  value: number | null;
  currentPriceCents: number | null;
  resultingPriceCents: number | null;
  marginKnown: boolean;
  estimatedMarginCents: number | null;
  rationale: string;
}

/** The conservative defaults a business that never opened the screen gets. */
export const DEFAULT_OFFER_RULES = {
  maxDiscountPercent: 20,
  minDiscountPercent: 5,
  minMarginPercent: null,
  allowPercentage: true,
  allowFixed: true,
  allowBundles: false,
  allowFreeShipping: true,
  allowSeasonal: true,
  allowAutomatic: false,
  requireApproval: true,
} as const;

export async function getOfferRules(
  context: BusinessContext,
  db: Db = prisma,
): Promise<OfferRules> {
  const existing = await db.offerRules.findUnique({ where: { businessId: context.businessId } });
  if (existing) return existing;

  // Created on first read rather than at onboarding, so the defaults live in
  // one place and a business created before this phase still gets them.
  return db.offerRules.create({
    data: { businessId: context.businessId, ...DEFAULT_OFFER_RULES },
  });
}

/**
 * Proposes offers for the products that can support one.
 *
 * Returns proposals without saving them, so a caller can show the owner what
 * would be created before anything exists. `createOffers` persists.
 */
export async function proposeOffers(
  context: BusinessContext,
  options: { limit?: number } = {},
  db: Db = prisma,
): Promise<{ proposals: OfferProposal[]; skipped: Array<{ name: string; reason: string }> }> {
  const rules = await getOfferRules(context, db);

  const products = await db.product.findMany({
    where: { businessId: context.businessId, removedAt: null },
    orderBy: { lastSeenAt: 'desc' },
    take: options.limit ?? 20,
  });

  const proposals: OfferProposal[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const product of products) {
    const outcome = proposeForProduct(product, rules);
    if ('reason' in outcome) skipped.push({ name: product.name, reason: outcome.reason });
    else proposals.push(outcome);
  }

  return { proposals, skipped };
}

/**
 * One product, one decision.
 *
 * Pure, so the rules above are testable without a database — which matters,
 * because these are the rules that decide what a merchant's customers are
 * charged.
 */
export function proposeForProduct(
  product: Pick<
    Product,
    'id' | 'name' | 'priceCents' | 'costCents' | 'currency' | 'availability' | 'comparePriceCents'
  >,
  rules: Pick<
    OfferRules,
    | 'maxDiscountPercent'
    | 'minDiscountPercent'
    | 'minMarginPercent'
    | 'allowPercentage'
    | 'allowFixed'
    | 'allowFreeShipping'
  >,
): OfferProposal | { reason: string } {
  if (product.availability === 'OUT_OF_STOCK') {
    return { reason: 'it is out of stock' };
  }

  if (product.priceCents === null || product.priceCents <= 0) {
    // Free shipping needs no price, so it is still available — but only as
    // itself, never as a percentage of a number we do not have.
    if (rules.allowFreeShipping) {
      return {
        productId: product.id,
        productName: product.name,
        type: 'FREE_SHIPPING',
        value: null,
        currentPriceCents: null,
        resultingPriceCents: null,
        marginKnown: false,
        estimatedMarginCents: null,
        rationale:
          'No price is stated on the page, so a discount cannot be calculated. Free shipping is offered instead because it does not depend on the price.',
      };
    }
    return { reason: 'its page states no price' };
  }

  if (!rules.allowPercentage && !rules.allowFixed) {
    return { reason: 'your settings do not allow discounts' };
  }

  /*
   * A product already showing a "was" price is already discounted. Stacking a
   * second reduction on top produces a number the merchant never agreed to,
   * and shoppers who saw both prices have every reason to be annoyed.
   */
  if (product.comparePriceCents !== null && product.comparePriceCents > product.priceCents) {
    return { reason: 'it is already on sale' };
  }

  const percent = rules.minDiscountPercent;
  if (percent <= 0 || percent > rules.maxDiscountPercent) {
    return { reason: 'your discount settings leave no room' };
  }

  // Round the *discount* down, so the resulting price never dips below what
  // the ceiling permits through a rounding artefact.
  const discountCents = Math.floor((product.priceCents * percent) / 100);
  const resultingPriceCents = product.priceCents - discountCents;

  if (resultingPriceCents <= 0) {
    return { reason: 'the discount would take the price to zero' };
  }

  /*
   * Margin, only where the merchant told us the cost. `costCents` is
   * merchant-supplied by construction — the scanner is forbidden from
   * inferring it — so its presence is a genuine signal rather than a guess
   * that happened to get stored.
   */
  const marginKnown = product.costCents !== null && product.costCents > 0;
  const estimatedMarginCents = marginKnown
    ? resultingPriceCents - (product.costCents as number)
    : null;

  if (marginKnown && estimatedMarginCents !== null) {
    if (estimatedMarginCents <= 0) {
      return { reason: 'the discount would sell it at a loss' };
    }
    if (rules.minMarginPercent !== null) {
      const marginPercent = (estimatedMarginCents / resultingPriceCents) * 100;
      if (marginPercent < rules.minMarginPercent) {
        return {
          reason: `it would leave less than your ${rules.minMarginPercent}% minimum margin`,
        };
      }
    }
  }

  const type: OfferType = rules.allowPercentage ? 'PERCENT_OFF' : 'FIXED_OFF';

  return {
    productId: product.id,
    productName: product.name,
    type,
    value: type === 'PERCENT_OFF' ? percent : discountCents,
    currentPriceCents: product.priceCents,
    resultingPriceCents,
    marginKnown,
    estimatedMarginCents,
    rationale: buildRationale(percent, marginKnown, rules.maxDiscountPercent),
  };
}

/**
 * Why this offer, in the owner's language.
 *
 * Says plainly when the margin is unknown. A rationale that quietly omitted
 * that would read as though the sums had been done.
 */
function buildRationale(percent: number, marginKnown: boolean, ceiling: number): string {
  const base = `A ${percent}% discount, the smallest your settings allow and well inside your ${ceiling}% ceiling.`;
  return marginKnown
    ? `${base} Your cost price is on file, so the margin below is calculated, not estimated.`
    : `${base} We do not know what this costs you, so the margin is shown as unknown rather than guessed.`;
}

/** Saves proposals as PROPOSED offers. Nothing becomes active here. */
export async function createOffers(
  context: BusinessContext,
  proposals: OfferProposal[],
  decisionId: string | null,
  db: Db = prisma,
): Promise<number> {
  if (isPaused(context.business)) {
    throw conflict('Everything is paused for this business', {
      publicMessage: 'Everything is paused. Resume first, then we can suggest offers.',
    });
  }
  if (proposals.length === 0) return 0;

  /*
   * Clear the previous suggestions first. Pressing "Suggest offers" twice
   * should refresh the list, not stack a second copy of it — and a proposal
   * nobody acted on is not history worth keeping, since the `ai_decisions`
   * row that produced it remains either way.
   *
   * Scoped to PROPOSED on purpose: an approved or active offer is a
   * commitment the merchant made, and regenerating suggestions must never
   * quietly withdraw one.
   */
  await db.offer.deleteMany({
    where: {
      businessId: context.businessId,
      status: 'PROPOSED',
      productId: { in: proposals.map((proposal) => proposal.productId) },
    },
  });

  const created = await db.offer.createMany({
    data: proposals.map((proposal) => ({
      businessId: context.businessId,
      productId: proposal.productId,
      type: proposal.type,
      value: proposal.value,
      resultingPriceCents: proposal.resultingPriceCents,
      marginKnown: proposal.marginKnown,
      estimatedMarginCents: proposal.estimatedMarginCents,
      rationale: proposal.rationale,
      status: 'PROPOSED' as const,
      aiDecisionId: decisionId,
    })),
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: context.businessId,
      actorType: 'AI',
      action: AUDIT_ACTIONS.offerProposed,
      objectType: 'Offer',
      newValue: { count: created.count },
    },
    db,
  );

  await recordActivity(
    context,
    {
      kind: 'offerProposed',
      message: `Suggested ${created.count} ${created.count === 1 ? 'offer' : 'offers'}. Nothing is live until you approve it.`,
      needsAttention: true,
      detail: { count: created.count },
    },
    db,
  );

  return created.count;
}

/**
 * Approves an offer and makes it active.
 *
 * Re-validates against the rules at approval time rather than trusting what
 * was computed when it was proposed: the merchant may have tightened their
 * ceiling, or the product's price may have moved, since. A stale proposal is
 * refused rather than honoured.
 */
export async function approveOffer(
  context: BusinessContext,
  offerId: string,
  userId: string,
  db: Db = prisma,
): Promise<Offer> {
  const offer = await db.offer.findFirst({
    where: { id: offerId, businessId: context.businessId },
    include: { product: true },
  });
  if (!offer) throw validationError('Offer not found');

  if (offer.status !== 'PROPOSED') {
    throw conflict(`Offer is already ${offer.status.toLowerCase()}`, {
      publicMessage: 'That offer has already been dealt with.',
    });
  }

  if (offer.product) {
    const rules = await getOfferRules(context, db);
    const fresh = proposeForProduct(offer.product, rules);

    if ('reason' in fresh) {
      throw conflict(`Offer no longer valid: ${fresh.reason}`, {
        publicMessage: `This offer is no longer suitable because ${fresh.reason}. We will suggest a new one.`,
      });
    }
    if (fresh.resultingPriceCents !== offer.resultingPriceCents) {
      throw conflict('Product price changed since this offer was proposed', {
        publicMessage:
          'The price on your website has changed since we suggested this. We will work it out again.',
      });
    }
  }

  const approved = await db.offer.update({
    where: { id: offer.id },
    data: {
      status: 'ACTIVE',
      approvedBy: userId,
      approvedAt: new Date(),
      startsAt: new Date(),
    },
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: context.businessId,
      actorType: 'USER',
      actorId: userId,
      action: AUDIT_ACTIONS.offerApproved,
      objectType: 'Offer',
      objectId: offer.id,
      previousValue: { status: offer.status },
      newValue: { status: 'ACTIVE' },
    },
    db,
  );

  return approved;
}

/**
 * The offers safe to advertise right now.
 *
 * Expiry is applied here rather than trusted from the status column, so an
 * offer whose `endsAt` has passed cannot be used because a sweep has not run
 * yet. §"never use an expired promotion" has to hold at the moment of use.
 */
export async function activeOffers(
  context: BusinessContext,
  now: Date = new Date(),
  db: Db = prisma,
): Promise<Offer[]> {
  return db.offer.findMany({
    where: {
      businessId: context.businessId,
      status: 'ACTIVE',
      OR: [{ endsAt: null }, { endsAt: { gt: now } }],
      AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }],
    },
    orderBy: { createdAt: 'desc' },
  });
}

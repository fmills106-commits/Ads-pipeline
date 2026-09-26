import { inTransaction, prisma, type Db } from '@/lib/db';
import { validationError } from '@/lib/errors';
import { assertSafePublicUrl } from '@/lib/net-safety';
import { recordAudit, AUDIT_ACTIONS } from '@/server/audit/log';
import { recordActivity } from '@/server/activity/feed';
import { JOB_TYPES } from '@/server/jobs/types';
import type { BusinessContext } from '@/server/tenancy/context';
import type { Business } from '@prisma/client';

/**
 * Changing or clearing the website address a business advertises.
 *
 * This exists because the first owner to use the deployment typed a website to
 * try it out and then had no way to take it back. That is not a missing button:
 * pointing a business at a different site invalidates everything downstream of
 * the old one, and until something knew what to discard there was nothing safe
 * to wire a button to.
 *
 * The rule is that the application must never describe one company using
 * another company's pages. Everything read from a site, and everything reasoned
 * from what was read, goes when the address changes:
 *
 *   - the Website row, which cascades to its pages, products, product images,
 *     versions and per-product facts, and its scan history
 *   - the business-level facts, which name the old company's contact details,
 *     policies and claims
 *   - the AI's profile and inferences, which are descriptions of the old site
 *   - offers and strategies not attached to a product, which the product
 *     cascade therefore leaves behind
 *
 * Three things deliberately survive:
 *
 *   - the **audit log**, because it is the record of what happened, including
 *     this deletion; erasing history to tidy up is how you lose the ability to
 *     answer "why did it do that?"
 *   - **cost records**, for the same reason — money spent stays spent
 *   - the **activity feed**, which gains an entry saying the address changed.
 *     The old entries stay true: we really did read that site.
 */

/** What a change discarded, so the owner can be told plainly. */
export interface DiscardedKnowledge {
  websites: number;
  products: number;
  facts: number;
  inferences: number;
  offers: number;
  strategies: number;
  cancelledScans: number;
}

export interface ChangeWebsiteResult {
  business: Business;
  discarded: DiscardedKnowledge;
}

const isEmpty = (counts: DiscardedKnowledge): boolean =>
  Object.values(counts).every((value) => value === 0);

/**
 * Points a business at a different website, or at none.
 *
 * Pass `null` to clear the address. Either way the previous site's knowledge is
 * discarded in the same transaction as the address change, so there is no
 * window in which the new URL is stored alongside the old site's products.
 */
export async function changeWebsite(
  context: BusinessContext,
  nextUrl: string | null,
  db: Db = prisma,
): Promise<ChangeWebsiteResult> {
  const trimmed = nextUrl?.trim() ?? null;
  const websiteUrl = trimmed === '' ? null : trimmed;

  // Re-checked here rather than trusted from the route: this is the function
  // that writes the value, and the crawler will later fetch whatever it stores.
  if (websiteUrl !== null) assertSafePublicUrl(websiteUrl);

  const previousUrl = context.business.websiteUrl;
  if (previousUrl === websiteUrl) {
    throw validationError(
      websiteUrl === null
        ? 'There is no website address to remove.'
        : 'That is already the website address.',
    );
  }

  const businessId = context.businessId;

  const { business, discarded } = await inTransaction(db, async (tx) => {
    /*
     * Stop the queue first. A scan claimed a moment ago is mid-crawl against
     * the old site; letting it finish would write pages belonging to a website
     * row this transaction is about to delete, or — worse, once the row is
     * gone and a new scan exists — attribute them to the new site.
     *
     * A RUNNING job cannot be interrupted from here, so this marks it
     * CANCELLED and relies on the worker finding its scan run gone and
     * stopping. That is the same path an owner-cancelled scan already takes.
     */
    const { count: cancelledScans } = await tx.job.updateMany({
      where: {
        businessId,
        type: JOB_TYPES.websiteScan,
        status: { in: ['PENDING', 'RUNNING'] },
      },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });

    // Cascades to pages, products, product images, versions, product facts,
    // scan runs, and — through the product — that product's offers, strategies
    // and ad copy. See prisma/schema.prisma.
    const productCount = await tx.product.count({ where: { businessId } });
    const { count: websites } = await tx.website.deleteMany({ where: { businessId } });

    // These hang off the business rather than the website, so no cascade
    // reaches them. Each one is a statement about the old site.
    const { count: facts } = await tx.businessFact.deleteMany({ where: { businessId } });
    const { count: inferences } = await tx.aiInference.deleteMany({ where: { businessId } });
    await tx.businessProfile.deleteMany({ where: { businessId } });

    // Whatever the product cascade left: the business-level offers and
    // strategies, whose productId is null.
    const { count: offers } = await tx.offer.deleteMany({ where: { businessId } });
    const { count: strategies } = await tx.marketingStrategy.deleteMany({ where: { businessId } });

    const updated = await tx.business.update({
      where: { id: businessId },
      data: { websiteUrl },
    });

    return {
      business: updated,
      discarded: {
        websites,
        products: productCount,
        facts,
        inferences,
        offers,
        strategies,
        cancelledScans,
      },
    };
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId,
      actorType: 'USER',
      actorId: context.user.id,
      action: AUDIT_ACTIONS.websiteChanged,
      objectType: 'Business',
      objectId: businessId,
      previousValue: { websiteUrl: previousUrl },
      // The counts are part of the record: they are the only trace of what the
      // discarded rows were, once they are gone.
      newValue: { websiteUrl, discarded },
    },
    db,
  );

  await recordActivity(
    context,
    {
      kind: 'websiteChanged',
      message: describeChange(previousUrl, websiteUrl, discarded),
      detail: { previousUrl, websiteUrl, ...discarded },
    },
    db,
  );

  return { business, discarded };
}

/**
 * One plain sentence about what just happened.
 *
 * Composed here from counts the transaction returned, never from a template
 * that guesses — "we removed your products" when there were none to remove
 * teaches an owner that the feed is decorative.
 */
function describeChange(
  previousUrl: string | null,
  websiteUrl: string | null,
  discarded: DiscardedKnowledge,
): string {
  const site = (url: string | null): string => (url ? hostOf(url) : 'no website');

  const headline =
    websiteUrl === null
      ? `Removed ${site(previousUrl)} as your website.`
      : previousUrl === null
        ? `Set your website to ${site(websiteUrl)}.`
        : `Changed your website from ${site(previousUrl)} to ${site(websiteUrl)}.`;

  if (isEmpty(discarded)) return `${headline} Nothing had been read from the old address yet.`;

  const parts: string[] = [];
  if (discarded.products > 0) {
    parts.push(`${discarded.products} product${discarded.products === 1 ? '' : 's'}`);
  }
  if (discarded.facts > 0) {
    parts.push(`${discarded.facts} fact${discarded.facts === 1 ? '' : 's'}`);
  }
  const offersAndStrategies = discarded.offers + discarded.strategies;
  if (offersAndStrategies > 0) parts.push('the advertising drafted from them');

  const cancelled = discarded.cancelledScans > 0 ? ' The scan in progress was stopped.' : '';

  if (parts.length === 0) return `${headline}${cancelled}`;
  return `${headline} We discarded ${joinWords(parts)}, because they described the old site.${cancelled}`;
}

/** The hostname, for a message an owner reads — not the full URL with its path. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

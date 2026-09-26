import { prisma, type Db } from '@/lib/db';
import { notFound, validationError } from '@/lib/errors';
import { AUDIT_ACTIONS, recordAudit } from '@/server/audit/log';
import type { BusinessContext } from '@/server/tenancy/context';
import type { Product } from '@prisma/client';

/**
 * What the owner knows that their website does not say.
 *
 * Two fields, and they are the two the engine cannot ever infer:
 *
 *  - **A description in their own words.** A page says what a page says. A
 *    one-page shop's pack cards say "Full Case" and "$132", and the fact that
 *    the contents are soft foam, slow-rising and Halloween-themed lives in
 *    prose three sections away that belongs to no product in particular.
 *    Guessing which paragraph describes which product is how an extractor
 *    invents things; asking is how it does not.
 *
 *  - **What it costs them.** Nothing on a web page states this, so margin is
 *    unknowable without it, and the offer engine refuses to propose a discount
 *    whose profitability it cannot prove. That refusal is correct, and it
 *    leaves the owner with no way to say "actually, here is the cost" — until
 *    this.
 *
 * Stored apart from the scraped values rather than over them. `description`
 * holds what the page said, with a source URL behind it, and a rescan
 * overwrites it because it is a record of the page. `ownerDescription` has no
 * source URL, is evidence of nothing about the site, and must survive every
 * future scan. Keeping them in separate columns is what lets "verified fact"
 * keep meaning what it says.
 */

export interface ProductDetailsInput {
  /** The owner's words. Empty string clears them and returns to the page's. */
  ownerDescription?: string | null;
  /** In cents. Null clears it, and margin becomes unknowable again. */
  costCents?: number | null;
}

const MAX_DESCRIPTION = 2_000;
const MAX_COST_CENTS = 100_000_000; // $1,000,000 a unit.

export async function setProductDetails(
  context: BusinessContext,
  productId: string,
  input: ProductDetailsInput,
  db: Db = prisma,
): Promise<Product> {
  /*
   * Scoped to this business in the `where`, not checked afterwards. A product
   * id belonging to another tenant finds nothing, which is a 404 — the same
   * answer as an id that does not exist, so the request cannot be used to
   * discover that somebody else's product is real.
   */
  const existing = await db.product.findFirst({
    where: { id: productId, businessId: context.businessId },
  });
  if (!existing) throw notFound('Product not found');

  const data: {
    ownerDescription?: string | null;
    ownerDescribedAt?: Date | null;
    costCents?: number | null;
  } = {};

  if (input.ownerDescription !== undefined) {
    const trimmed = input.ownerDescription?.trim() ?? '';
    if (trimmed.length > MAX_DESCRIPTION) {
      throw validationError('That description is too long.', {
        publicMessage: `Please keep it under ${MAX_DESCRIPTION} characters.`,
      });
    }
    data.ownerDescription = trimmed === '' ? null : trimmed;
    data.ownerDescribedAt = trimmed === '' ? null : new Date();
  }

  if (input.costCents !== undefined) {
    if (input.costCents !== null) {
      if (!Number.isInteger(input.costCents) || input.costCents < 0) {
        throw validationError('That cost is not a usable amount.');
      }
      if (input.costCents > MAX_COST_CENTS) {
        throw validationError('That cost is not a usable amount.');
      }
      /*
       * A cost above the price is not refused. Loss-leaders are real, and so
       * are typos — but the offer engine already declines to propose a
       * discount that loses money, so the honest thing is to store what the
       * owner said and let that guard do its job, rather than arguing with
       * them about their own numbers.
       */
    }
    data.costCents = input.costCents;
  }

  if (Object.keys(data).length === 0) return existing;

  const updated = await db.product.update({ where: { id: existing.id }, data });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: context.businessId,
      actorType: 'USER',
      actorId: context.user.id,
      action: AUDIT_ACTIONS.productDetailsEdited,
      objectType: 'Product',
      objectId: updated.id,
      previousValue: {
        ownerDescription: existing.ownerDescription,
        costCents: existing.costCents,
      },
      newValue: {
        ownerDescription: updated.ownerDescription,
        costCents: updated.costCents,
      },
    },
    db,
  );

  return updated;
}

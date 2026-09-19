import type { Business } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { AUDIT_ACTIONS, recordAudit } from '@/server/audit/log';
import { recordActivity } from '@/server/activity/feed';
import type { BusinessContext } from '@/server/tenancy/context';

/**
 * PAUSE EVERYTHING.
 *
 * One control, one obvious effect: nothing launches, nothing spends, no
 * automation runs. It is the safety valve for an owner who does not want to
 * reason about which of six campaigns is the problem — and for the system
 * itself, which pauses on its own when a safeguard trips.
 *
 * The pause is recorded on the business rather than inferred from campaign
 * states, so it holds even for work that has not been created yet: a job that
 * would generate and launch a campaign checks `assertNotPaused` before doing
 * anything, and a pause therefore stops future spending as well as current.
 */

export type PauseActor = 'USER' | 'SYSTEM';

export interface PauseInput {
  /** Shown to the owner. Plain language. */
  reason: string;
  actor?: PauseActor;
}

export async function pauseEverything(
  context: BusinessContext,
  input: PauseInput,
  db: Db = prisma,
): Promise<Business> {
  if (context.business.pausedAt !== null) return context.business;

  const paused = await db.business.update({
    where: { id: context.businessId },
    data: { pausedAt: new Date(), pauseReason: input.reason },
  });

  const actor = input.actor ?? 'USER';

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: paused.id,
      actorType: actor,
      actorId: actor === 'USER' ? context.user.id : null,
      action: AUDIT_ACTIONS.allCampaignsPaused,
      objectType: 'Business',
      objectId: paused.id,
      newValue: { pausedAt: paused.pausedAt?.toISOString() ?? null, reason: input.reason },
    },
    db,
  );

  await recordActivity(
    { ...context, business: paused },
    {
      kind: 'everythingPaused',
      message:
        actor === 'USER'
          ? 'You paused all advertising. Nothing will run or spend until you resume.'
          : `Advertising paused automatically: ${input.reason}`,
      needsAttention: true,
    },
    db,
  );

  logger().warn('All advertising paused', {
    businessId: paused.id,
    actor,
    reason: input.reason,
  });

  // Phase 5 onward: this is where live campaigns are paused at the advertising
  // provider too. The database flag already stops anything this system would
  // start, so the guarantee holds today for every campaign that exists.
  return paused;
}

export async function resumeEverything(
  context: BusinessContext,
  db: Db = prisma,
): Promise<Business> {
  if (context.business.pausedAt === null) return context.business;

  const resumed = await db.business.update({
    where: { id: context.businessId },
    data: { pausedAt: null, pauseReason: null },
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: resumed.id,
      actorType: 'USER',
      actorId: context.user.id,
      action: AUDIT_ACTIONS.businessUpdated,
      objectType: 'Business',
      objectId: resumed.id,
      previousValue: { pausedAt: context.business.pausedAt?.toISOString() ?? null },
      newValue: { pausedAt: null },
    },
    db,
  );

  await recordActivity(
    { ...context, business: resumed },
    { kind: 'everythingResumed', message: 'Advertising resumed.' },
    db,
  );

  return resumed;
}

/** Thrown by `assertNotPaused`. */
export class BusinessPausedError extends Error {
  readonly reason: string | null;
  constructor(reason: string | null) {
    super(`Business is paused: ${reason ?? 'no reason recorded'}`);
    this.name = 'BusinessPausedError';
    this.reason = reason;
  }
}

/**
 * The gate every spending or publishing action must pass.
 *
 * Call this at the top of anything that launches a campaign, raises a budget,
 * or publishes an ad — not at the UI layer, where a background job would
 * bypass it.
 */
export function assertNotPaused(business: Pick<Business, 'pausedAt' | 'pauseReason'>): void {
  if (business.pausedAt !== null) {
    throw new BusinessPausedError(business.pauseReason);
  }
}

export const isPaused = (business: Pick<Business, 'pausedAt'>): boolean =>
  business.pausedAt !== null;

import { Prisma, type ActivitySeverity } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { BusinessContext } from '@/server/tenancy/context';

/**
 * The owner-facing activity feed.
 *
 * Separate from the audit log by design. The audit log is the complete
 * technical record — every field change, every actor, every old and new value
 * — and it stays exactly as it is, for debugging and accountability. This is
 * the short version a business owner reads over coffee:
 *
 *   🤖 Created 3 new Halloween ad variations.
 *   📊 Ad #4 is performing better than the others.
 *   ⚠️  Product price changed on the website. Updated advertising materials.
 *
 * Two rules keep it trustworthy:
 *
 *  1. Messages are composed here, server-side, from values the caller has
 *     already verified. A model's prose never becomes an activity message —
 *     otherwise the feed inherits every hallucination the model makes.
 *  2. Every activity event corresponds to something that actually happened.
 *     Nothing is written speculatively or in advance.
 */

/** Event kinds, with the icon and default severity the UI renders. */
export const ACTIVITY_KINDS = {
  websiteScanned: { icon: '🔍', severity: 'INFO' },
  websiteChanged: { icon: '🔁', severity: 'NOTICE' },
  productsFound: { icon: '📦', severity: 'INFO' },
  analysisReady: { icon: '🧠', severity: 'INFO' },
  strategiesGenerated: { icon: '🤖', severity: 'INFO' },
  adCopyReady: { icon: '✍️', severity: 'INFO' },
  creativesGenerated: { icon: '🎨', severity: 'INFO' },
  creativeNeedsReview: { icon: '👀', severity: 'ATTENTION' },
  offerProposed: { icon: '🏷️', severity: 'ATTENTION' },
  campaignLaunched: { icon: '🚀', severity: 'NOTICE' },
  campaignPaused: { icon: '⏸️', severity: 'NOTICE' },
  performanceUpdate: { icon: '📊', severity: 'INFO' },
  experimentStarted: { icon: '🧪', severity: 'INFO' },
  experimentConcluded: { icon: '🏁', severity: 'INFO' },
  variationsCreated: { icon: '🔄', severity: 'INFO' },
  priceChanged: { icon: '⚠️', severity: 'NOTICE' },
  productUnavailable: { icon: '⏸️', severity: 'ATTENTION' },
  budgetReached: { icon: '💰', severity: 'NOTICE' },
  everythingPaused: { icon: '🛑', severity: 'ATTENTION' },
  everythingResumed: { icon: '▶️', severity: 'NOTICE' },
  onboardingCompleted: { icon: '✅', severity: 'INFO' },
  needsYourInput: { icon: '❓', severity: 'ATTENTION' },
  providerFellBack: { icon: 'ℹ️', severity: 'NOTICE' },
} as const satisfies Record<string, { icon: string; severity: ActivitySeverity }>;

export type ActivityKind = keyof typeof ACTIVITY_KINDS;

export const activityIcon = (kind: string): string =>
  (ACTIVITY_KINDS as Record<string, { icon: string }>)[kind]?.icon ?? '•';

export interface RecordActivityInput {
  kind: ActivityKind;
  /** One plain sentence. Already safe to show; no technical vocabulary. */
  message: string;
  severity?: ActivitySeverity;
  detail?: Prisma.InputJsonValue;
  /** True when the owner has to decide something before work continues. */
  needsAttention?: boolean;
}

/**
 * Appends one activity event.
 *
 * Never throws, for the same reason the audit writer does not: a feed entry
 * failing must not roll back the work it describes.
 */
/**
 * How close together two identical entries have to be to count as one.
 *
 * A double-clicked button, or a form submitted twice while the first request
 * was still in flight, produces the same sentence twice with the same
 * timestamp. Both writes are real, and the audit log keeps both — but the feed
 * is the short version somebody reads over coffee, and the same sentence twice
 * tells them something happened twice when it happened once.
 */
const DUPLICATE_WINDOW_MS = 60_000;

export async function recordActivity(
  context: BusinessContext,
  input: RecordActivityInput,
  db: Db = prisma,
): Promise<void> {
  const defaults = ACTIVITY_KINDS[input.kind];
  const severity = input.severity ?? defaults.severity;

  try {
    const duplicate = await db.activityEvent.findFirst({
      where: {
        businessId: context.businessId,
        kind: input.kind,
        message: input.message,
        createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (duplicate) return;
  } catch {
    // Not worth failing the write for: a duplicate entry is untidy, a lost
    // entry is a gap in the record.
  }

  try {
    await db.activityEvent.create({
      data: {
        workspaceId: context.workspace.id,
        businessId: context.businessId,
        kind: input.kind,
        severity,
        message: input.message,
        detail: input.detail ?? Prisma.DbNull,
        needsAttention: input.needsAttention ?? severity === 'ATTENTION',
      },
    });
  } catch (error) {
    logger().error('Failed to write activity event', {
      error,
      kind: input.kind,
      businessId: context.businessId,
    });
  }
}

export interface ActivityItem {
  id: string;
  kind: string;
  icon: string;
  severity: ActivitySeverity;
  message: string;
  needsAttention: boolean;
  createdAt: Date;
}

/** The most recent events for a business, newest first. */
export async function recentActivity(
  context: BusinessContext,
  limit = 20,
  db: Db = prisma,
): Promise<ActivityItem[]> {
  const rows = await db.activityEvent.findMany({
    where: { businessId: context.businessId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 100),
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    icon: activityIcon(row.kind),
    severity: row.severity,
    message: row.message,
    needsAttention: row.needsAttention,
    createdAt: row.createdAt,
  }));
}

/** How many things are waiting on the owner. Drives the dashboard badge. */
export async function pendingAttentionCount(
  context: BusinessContext,
  db: Db = prisma,
): Promise<number> {
  return db.activityEvent.count({
    where: { businessId: context.businessId, needsAttention: true, resolvedAt: null },
  });
}

/**
 * Marks earlier "needs your input" entries answered.
 *
 * `resolvedAt` has been on the model and filtered by `pendingAttentionCount`
 * since the feed was built, and nothing ever set it — so an owner whose
 * website was blocked, who then fixed their firewall and scanned
 * successfully, still had "2 things need your input" on the dashboard,
 * pointing at problems that no longer existed and offering no way to say so.
 * A question that cannot be answered stops being read.
 *
 * Called where the condition clears, by the code that knows it cleared: a scan
 * that succeeds answers the scan failures before it, and resuming answers the
 * pause. The entries stay in the feed — they happened — they just stop asking.
 */
export async function resolveAttention(
  context: BusinessContext,
  /**
   * Which kinds to answer. Omit for all of them, which is what the owner
   * pressing "mark as handled" means.
   *
   * Automatic resolution names kinds because the code that knows a condition
   * cleared only knows about its own. The owner needs no such restraint: they
   * can see the list, and if they say it is dealt with, it is dealt with.
   * Without that, an item flagged by something that never happens again stays
   * on the dashboard forever — which is how the count got to three and stayed
   * there after the problems behind it were fixed.
   */
  kinds?: ActivityKind[],
  db: Db = prisma,
): Promise<number> {
  try {
    const { count } = await db.activityEvent.updateMany({
      where: {
        businessId: context.businessId,
        ...(kinds ? { kind: { in: kinds } } : {}),
        needsAttention: true,
        resolvedAt: null,
      },
      data: { resolvedAt: new Date() },
    });
    return count;
  } catch (error) {
    logger().error('Failed to resolve activity attention', {
      error,
      businessId: context.businessId,
    });
    return 0;
  }
}

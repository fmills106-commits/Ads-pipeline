import { Prisma, type AuditActorType } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { logger } from '@/lib/logger';

/**
 * Append-only audit trail.
 *
 * Every state change a user or the AI makes that affects money, publishing, or
 * business knowledge gets a row here. `actorType` is what makes the log worth
 * keeping: it records whether a human or the automation made each decision.
 */

/**
 * Known action verbs. Typed rather than free-form so the dashboard can render
 * them and so typos do not silently create a new category.
 */
export const AUDIT_ACTIONS = {
  // identity
  userRegistered: 'user.registered',
  userLoggedIn: 'user.logged_in',
  userLoggedOut: 'user.logged_out',
  userLoginFailed: 'user.login_failed',

  // tenancy
  workspaceCreated: 'workspace.created',
  businessCreated: 'business.created',
  businessUpdated: 'business.updated',
  businessArchived: 'business.archived',
  /// The address changed, and everything read from the old one was discarded.
  websiteChanged: 'business.website_changed',
  automationLevelChanged: 'business.automation_level_changed',
  budgetLimitsChanged: 'business.budget_limits_changed',

  // later phases — declared here so the vocabulary stays in one place
  websiteScanStarted: 'website.scan_started',
  websiteScanCompleted: 'website.scan_completed',
  businessAnalysed: 'business.analysed',
  strategiesGenerated: 'strategy.generated',
  adCopyGenerated: 'ad_copy.generated',
  offerProposed: 'offer.proposed',
  offerApproved: 'offer.approved',
  creativeGenerated: 'creative.generated',
  creativeApproved: 'creative.approved',
  creativeRejected: 'creative.rejected',
  campaignLaunched: 'campaign.launched',
  campaignPaused: 'campaign.paused',
  campaignBudgetChanged: 'campaign.budget_changed',
  allCampaignsPaused: 'campaign.emergency_pause_all',
  integrationConnected: 'integration.connected',
  /// A workspace switched a paid service on or off. Kept distinct from a
  /// generic update so "who let this spend money?" is one query.
  providerEnabled: 'provider.enabled',
  providerDisabled: 'provider.disabled',
  /// A workspace stored or removed its own API key for a paid service. Distinct
  /// from enabling it, because they are different acts with different blast
  /// radii: one supplies the means to spend, the other grants permission. The
  /// row records the last four characters of the key and never the key.
  providerKeySet: 'provider.key_set',
  providerKeyRemoved: 'provider.key_removed',
  /// The owner described a product, or told us what it costs them — the two
  /// things no page states and no extractor may infer.
  productDetailsEdited: 'product.details_edited',
  integrationTokenRefreshed: 'integration.token_refreshed',
  integrationDisconnected: 'integration.disconnected',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export interface AuditEntry {
  workspaceId: string;
  businessId?: string | null;
  actorType: AuditActorType;
  /** User id when `actorType` is USER; omitted for SYSTEM and AI. */
  actorId?: string | null;
  action: AuditAction;
  objectType?: string | null;
  objectId?: string | null;
  previousValue?: Prisma.InputJsonValue | null;
  newValue?: Prisma.InputJsonValue | null;
  metadata?: Prisma.InputJsonValue | null;
  ipAddress?: string | null;
}

/**
 * Writes one audit row.
 *
 * Deliberately never throws. An audit write failing must not roll back the
 * business action that succeeded — the failure is logged at error level for
 * alerting instead. Pass the transaction handle as `db` when the audit row
 * genuinely must be atomic with the change.
 */
export async function recordAudit(entry: AuditEntry, db: Db = prisma): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        workspaceId: entry.workspaceId,
        businessId: entry.businessId ?? null,
        actorType: entry.actorType,
        actorId: entry.actorId ?? null,
        action: entry.action,
        objectType: entry.objectType ?? null,
        objectId: entry.objectId ?? null,
        previousValue: entry.previousValue ?? Prisma.DbNull,
        newValue: entry.newValue ?? Prisma.DbNull,
        metadata: entry.metadata ?? Prisma.DbNull,
        ipAddress: entry.ipAddress ?? null,
      },
    });
  } catch (error) {
    logger().error('Failed to write audit log entry', {
      error,
      action: entry.action,
      workspaceId: entry.workspaceId,
      businessId: entry.businessId,
    });
  }
}

/**
 * Compares two records and returns only the fields that differ.
 *
 * The result is typed as `Prisma.InputJsonObject` so it drops straight into an
 * audit entry's `previousValue`/`newValue` without a cast at every call site.
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
  fields: ReadonlyArray<keyof T>,
): { previous: Prisma.InputJsonObject; next: Prisma.InputJsonObject } | null {
  const previous: Record<string, Prisma.InputJsonValue> = {};
  const next: Record<string, Prisma.InputJsonValue> = {};
  let changed = false;

  for (const field of fields) {
    if (!(field in after)) continue;
    if (Object.is(before[field], after[field])) continue;
    // Audited fields are scalars (strings, numbers, enums) or null, all of
    // which are valid JSON; `toJsonValue` normalises the few that are not.
    previous[field as string] = toJsonValue(before[field]);
    next[field as string] = toJsonValue(after[field]);
    changed = true;
  }

  return changed ? { previous, next } : null;
}

/** Narrows an arbitrary field value to something Prisma will accept as JSON. */
function toJsonValue(value: unknown): Prisma.InputJsonValue {
  if (value === null || value === undefined)
    return Prisma.JsonNull as unknown as Prisma.InputJsonValue;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

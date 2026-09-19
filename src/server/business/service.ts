import type { Business, Prisma } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { conflict, validationError } from '@/lib/errors';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { AUDIT_ACTIONS, diffFields, recordAudit } from '@/server/audit/log';
import {
  requireBusinessContext,
  scopedToWorkspace,
  type BusinessContext,
  type WorkspaceContext,
} from '@/server/tenancy/context';

/**
 * Business CRUD.
 *
 * Every function here takes a resolved tenant context rather than a raw id, so
 * a caller cannot reach a business without having passed the membership check
 * in `src/server/tenancy/context.ts`.
 */

export interface CreateBusinessInput {
  name: string;
  industry?: string | null;
  websiteUrl?: string | null;
  description?: string | null;
  currency?: string;
  timezone?: string;
}

export async function createBusiness(
  context: WorkspaceContext,
  input: CreateBusinessInput,
  db: Db = prisma,
): Promise<Business> {
  const name = input.name.trim();
  if (name.length === 0) throw validationError('Business name is required');
  if (input.websiteUrl) assertSafePublicUrl(input.websiteUrl);

  const existing = await db.business.findFirst({
    where: { ...scopedToWorkspace(context), name },
    select: { id: true },
  });
  if (existing) throw conflict('A business with that name already exists in this workspace');

  const env = getEnv();
  const business = await db.business.create({
    data: {
      workspaceId: context.workspace.id,
      name,
      industry: input.industry?.trim() || null,
      websiteUrl: input.websiteUrl?.trim() || null,
      description: input.description?.trim() || null,
      currency: (input.currency ?? 'USD').toUpperCase(),
      timezone: input.timezone ?? 'UTC',
      // Start at the safest automation level and the platform ceilings; the
      // merchant raises these deliberately, and each change is audited.
      // Goal, budget and automation are set in onboarding steps 2-4. Until
      // then the business exists but cannot spend: `goal` and `budgetAmountCents`
      // are null, and every spending path requires them.
      automationMode: 'ASK_ME_FIRST',
      maxDailyBudgetCents: env.MAX_DAILY_BUDGET_CENTS,
      maxCampaignBudgetCents: env.MAX_CAMPAIGN_BUDGET_CENTS,
      budgetApprovalThresholdCents: env.BUDGET_APPROVAL_THRESHOLD_CENTS,
    },
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: business.id,
      actorType: 'USER',
      actorId: context.user.id,
      action: AUDIT_ACTIONS.businessCreated,
      objectType: 'Business',
      objectId: business.id,
      newValue: { name: business.name, industry: business.industry },
    },
    db,
  );

  logger().info('Business created', {
    businessId: business.id,
    workspaceId: context.workspace.id,
  });
  return business;
}

export async function listBusinesses(
  context: WorkspaceContext,
  options: { includeArchived?: boolean } = {},
  db: Db = prisma,
): Promise<Business[]> {
  return db.business.findMany({
    where: {
      ...scopedToWorkspace(context),
      ...(options.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: { createdAt: 'desc' },
  });
}

export type UpdateBusinessInput = Partial<
  Pick<Business, 'name' | 'industry' | 'websiteUrl' | 'description' | 'currency' | 'timezone'>
>;

const UPDATABLE_FIELDS = [
  'name',
  'industry',
  'websiteUrl',
  'description',
  'currency',
  'timezone',
] as const satisfies ReadonlyArray<keyof Business>;

export async function updateBusiness(
  context: BusinessContext,
  input: UpdateBusinessInput,
  db: Db = prisma,
): Promise<Business> {
  if (input.websiteUrl) assertSafePublicUrl(input.websiteUrl);
  if (input.name !== undefined && input.name.trim().length === 0) {
    throw validationError('Business name cannot be empty');
  }

  // Build the update payload from the allow-list rather than from `input`
  // directly, so an unexpected key can never reach the database.
  const data: Prisma.BusinessUpdateInput = {};
  for (const field of UPDATABLE_FIELDS) {
    if (!(field in input)) continue;
    const value = input[field];
    if (Object.is(context.business[field], value)) continue;
    Object.assign(data, { [field]: value });
  }
  if (Object.keys(data).length === 0) return context.business;

  const changes = diffFields(context.business, input, UPDATABLE_FIELDS);

  const updated = await db.business.update({
    where: { id: context.businessId },
    data,
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: updated.id,
      actorType: 'USER',
      actorId: context.user.id,
      action: AUDIT_ACTIONS.businessUpdated,
      objectType: 'Business',
      objectId: updated.id,
      previousValue: changes?.previous ?? null,
      newValue: changes?.next ?? null,
    },
    db,
  );

  return updated;
}

export async function archiveBusiness(
  context: BusinessContext,
  db: Db = prisma,
): Promise<Business> {
  const archived = await db.business.update({
    where: { id: context.businessId },
    data: { archivedAt: new Date() },
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: archived.id,
      actorType: 'USER',
      actorId: context.user.id,
      action: AUDIT_ACTIONS.businessArchived,
      objectType: 'Business',
      objectId: archived.id,
    },
    db,
  );

  return archived;
}

/** Re-exported so callers have one import for the business access path. */
export { requireBusinessContext };

/**
 * Rejects URLs the crawler must never be pointed at.
 *
 * This is the first line of SSRF defence: it runs at the moment a user supplies
 * a website URL, long before any fetch. It is NOT sufficient on its own — DNS
 * can resolve a public hostname to a private address — so the crawler in
 * Phase 2 re-validates the *resolved* IP immediately before connecting.
 */
export function assertSafePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw validationError('Website URL is not a valid URL');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw validationError('Website URL must use http or https');
  }
  if (url.username || url.password) {
    throw validationError('Website URL must not contain credentials');
  }

  const host = url.hostname.toLowerCase();
  if (isPrivateHostname(host)) {
    throw validationError('Website URL must point at a public host');
  }

  return url;
}

/** Literal private/loopback/link-local targets, and obvious internal names. */
function isPrivateHostname(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '[::1]' || host === '::1') return true;
  if (host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;

  // IPv4 literals in private, loopback, link-local or reserved ranges.
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1, 5).map(Number);
    const [a = 0, b = 0] = octets;
    if (octets.some((octet) => octet > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;

  return false;
}

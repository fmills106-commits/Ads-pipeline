import type { Business, User, Workspace, WorkspaceRole } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { forbidden, tenantMismatch, unauthenticated } from '@/lib/errors';

/**
 * Tenant context and access guards.
 *
 * The isolation rule for this platform is absolute: no query may read or write
 * a row belonging to a workspace the caller is not a member of, and no
 * business-scoped record may be reached except through a resolved
 * `BusinessContext`.
 *
 * The mechanism is a capability object. A caller cannot construct a
 * `BusinessContext` by hand — it comes back only from `requireBusinessContext`,
 * which has already verified membership against the database. Data-access
 * helpers take that object rather than a bare `businessId` string, so
 * "forgot to filter by tenant" is not a mistake that typechecks.
 */

/** Ordered least- to most-privileged; used by `hasAtLeastRole`. */
const ROLE_RANK: Record<WorkspaceRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

export function hasAtLeastRole(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** Brand that only this module can apply, so contexts cannot be forged. */
declare const verifiedBrand: unique symbol;

export interface WorkspaceContext {
  readonly [verifiedBrand]: true;
  readonly user: User;
  readonly workspace: Workspace;
  readonly role: WorkspaceRole;
}

export interface BusinessContext extends WorkspaceContext {
  readonly business: Business;
  /** Convenience mirror of `business.id`, for query filters. */
  readonly businessId: string;
}

function brand<T extends object>(value: T): T & { readonly [verifiedBrand]: true } {
  return value as T & { readonly [verifiedBrand]: true };
}

/**
 * Resolves the caller's membership of a workspace.
 *
 * @throws UNAUTHENTICATED when there is no user.
 * @throws TENANT_MISMATCH (surfaced as 404) when the workspace does not exist
 * or the user is not a member — the two cases are deliberately
 * indistinguishable to the caller.
 */
export async function requireWorkspaceContext(
  user: User | null | undefined,
  workspaceId: string,
  options: { minimumRole?: WorkspaceRole; db?: Db } = {},
): Promise<WorkspaceContext> {
  if (!user) throw unauthenticated('Workspace access attempted without a user');
  const db = options.db ?? prisma;

  const membership = await db.workspaceMembership.findUnique({
    where: { userId_workspaceId: { userId: user.id, workspaceId } },
    include: { workspace: true },
  });

  if (!membership) {
    throw tenantMismatch('User is not a member of the requested workspace', {
      details: { userId: user.id, workspaceId },
    });
  }

  if (options.minimumRole && !hasAtLeastRole(membership.role, options.minimumRole)) {
    throw forbidden('Insufficient workspace role', {
      details: { required: options.minimumRole, actual: membership.role },
    });
  }

  return brand({ user, workspace: membership.workspace, role: membership.role });
}

/**
 * Resolves a business together with the caller's membership of its workspace.
 *
 * Membership is checked against the business's *actual* workspace, read from
 * the row — never against a workspace id supplied by the caller. That is what
 * makes it impossible to reach Business B by passing Workspace A's id.
 */
export async function requireBusinessContext(
  user: User | null | undefined,
  businessId: string,
  options: { minimumRole?: WorkspaceRole; db?: Db; includeArchived?: boolean } = {},
): Promise<BusinessContext> {
  if (!user) throw unauthenticated('Business access attempted without a user');
  const db = options.db ?? prisma;

  const business = await db.business.findUnique({ where: { id: businessId } });
  if (!business) {
    throw tenantMismatch('Business not found', { details: { businessId } });
  }
  if (business.archivedAt !== null && !options.includeArchived) {
    throw tenantMismatch('Business is archived', { details: { businessId } });
  }

  const workspaceContext = await requireWorkspaceContext(user, business.workspaceId, {
    ...(options.minimumRole ? { minimumRole: options.minimumRole } : {}),
    db,
  });

  return brand({ ...workspaceContext, business, businessId: business.id });
}

/** Every workspace the user belongs to, with their role in each. */
export async function listWorkspacesForUser(
  user: User,
  db: Db = prisma,
): Promise<Array<{ workspace: Workspace; role: WorkspaceRole }>> {
  const memberships = await db.workspaceMembership.findMany({
    where: { userId: user.id },
    include: { workspace: true },
    orderBy: { createdAt: 'asc' },
  });
  return memberships.map(({ workspace, role }) => ({ workspace, role }));
}

/**
 * Asserts that a record already loaded from the database belongs to `context`.
 *
 * Use this at any point where a row was fetched by an id that came from
 * outside — a URL parameter, a webhook body, a job payload — before acting on
 * it. Cheap, and it turns a silent cross-tenant write into a 404.
 */
export function assertBelongsToBusiness(
  context: BusinessContext,
  record: { businessId: string } | null | undefined,
  what: string,
): asserts record is { businessId: string } {
  if (!record) {
    throw tenantMismatch(`${what} not found`, { details: { businessId: context.businessId } });
  }
  if (record.businessId !== context.businessId) {
    throw tenantMismatch(`${what} belongs to a different business`, {
      details: { expected: context.businessId, actual: record.businessId },
    });
  }
}

/** The workspace-level equivalent of `assertBelongsToBusiness`. */
export function assertBelongsToWorkspace(
  context: WorkspaceContext,
  record: { workspaceId: string } | null | undefined,
  what: string,
): asserts record is { workspaceId: string } {
  if (!record) {
    throw tenantMismatch(`${what} not found`, { details: { workspaceId: context.workspace.id } });
  }
  if (record.workspaceId !== context.workspace.id) {
    throw tenantMismatch(`${what} belongs to a different workspace`, {
      details: { expected: context.workspace.id, actual: record.workspaceId },
    });
  }
}

/**
 * The mandatory `where` fragment for any business-scoped query.
 *
 * Spelling the filter as a helper rather than inlining `{ businessId }` makes
 * its absence visible in review.
 */
export const scopedToBusiness = (context: BusinessContext): { businessId: string } => ({
  businessId: context.businessId,
});

export const scopedToWorkspace = (context: WorkspaceContext): { workspaceId: string } => ({
  workspaceId: context.workspace.id,
});

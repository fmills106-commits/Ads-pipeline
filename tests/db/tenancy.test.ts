import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/lib/db';
import {
  assertBelongsToBusiness,
  assertBelongsToWorkspace,
  hasAtLeastRole,
  listWorkspacesForUser,
  requireBusinessContext,
  requireWorkspaceContext,
  scopedToBusiness,
} from '@/server/tenancy/context';
import { createBusiness, listBusinesses, updateBusiness } from '@/server/business/service';
import {
  addMember,
  createTestBusiness,
  createTestUser,
  createTestWorkspace,
  createTwoTenants,
  resetDatabase,
} from '../helpers/db';

beforeEach(resetDatabase);

/**
 * The isolation contract.
 *
 * Tenant A and Tenant B here are two arbitrary, unrelated businesses — a coffee
 * roaster and a marine supplier. Nothing about either is known to the platform,
 * which is the point: the guarantee is structural, not category-specific.
 */
describe('tenant isolation', () => {
  it("does not let tenant A's user open tenant B's business", async () => {
    const { a, b } = await createTwoTenants();

    await expect(requireBusinessContext(a.user, b.business.id)).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    });
  });

  it("does not let tenant A's user open tenant B's workspace", async () => {
    const { a, b } = await createTwoTenants();

    await expect(requireWorkspaceContext(a.user, b.workspace.id)).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    });
  });

  it('reports a foreign business as 404, never 403', async () => {
    const { a, b } = await createTwoTenants();

    // A 403 would confirm the business exists. Existence is itself a leak.
    const error = await requireBusinessContext(a.user, b.business.id).catch((e) => e);
    expect(error.status).toBe(404);
    expect(error.publicMessage).toBe('That item could not be found.');
  });

  it('is indistinguishable from a business that does not exist at all', async () => {
    const { a, b } = await createTwoTenants();

    const foreign = await requireBusinessContext(a.user, b.business.id).catch((e) => e);
    const missing = await requireBusinessContext(a.user, crypto.randomUUID()).catch((e) => e);

    expect(foreign.status).toBe(missing.status);
    expect(foreign.publicMessage).toBe(missing.publicMessage);
  });

  it('lists only the caller’s own businesses', async () => {
    const { a, b } = await createTwoTenants();

    const listedForA = await listBusinesses(await requireWorkspaceContext(a.user, a.workspace.id));
    const listedForB = await listBusinesses(await requireWorkspaceContext(b.user, b.workspace.id));

    expect(listedForA.map((x) => x.id)).toEqual([a.business.id]);
    expect(listedForB.map((x) => x.id)).toEqual([b.business.id]);
  });

  it("cannot reach tenant B's business by supplying tenant A's workspace id", async () => {
    // Membership is checked against the business's actual workspace, read from
    // the row — never against a workspace id the caller supplied.
    const { a, b } = await createTwoTenants();
    await addMember(a.workspace, b.user, 'ADMIN');

    await expect(requireBusinessContext(b.user, a.business.id)).resolves.toMatchObject({
      businessId: a.business.id,
    });
    await expect(requireBusinessContext(a.user, b.business.id)).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    });
  });

  it("does not let tenant A's user update tenant B's business", async () => {
    const { a, b } = await createTwoTenants();

    await expect(
      requireBusinessContext(a.user, b.business.id).then((context) =>
        updateBusiness(context, { name: 'Hijacked' }),
      ),
    ).rejects.toMatchObject({ code: 'TENANT_MISMATCH' });

    const unchanged = await prisma.business.findUniqueOrThrow({ where: { id: b.business.id } });
    expect(unchanged.name).toBe('Harbour Marine Supply');
  });

  it('produces a scope filter that pins queries to one business', async () => {
    const { a, b } = await createTwoTenants();
    const contextA = await requireBusinessContext(a.user, a.business.id);

    expect(scopedToBusiness(contextA)).toEqual({ businessId: a.business.id });
    expect(scopedToBusiness(contextA).businessId).not.toBe(b.business.id);
  });

  it('keeps audit logs separated by business', async () => {
    const { a, b } = await createTwoTenants();
    const contextA = await requireWorkspaceContext(a.user, a.workspace.id);
    const contextB = await requireWorkspaceContext(b.user, b.workspace.id);

    await createBusiness(contextA, { name: 'A second roastery' });
    await createBusiness(contextB, { name: 'A second chandlery' });

    const auditForA = await prisma.auditLog.findMany({ where: { workspaceId: a.workspace.id } });
    expect(auditForA.length).toBeGreaterThan(0);
    expect(auditForA.every((entry) => entry.workspaceId === a.workspace.id)).toBe(true);
  });

  it('allows the same business name in two different workspaces', async () => {
    // Uniqueness is per workspace. Two unrelated tenants may both have a
    // business called "Store"; neither should block the other.
    const { a, b } = await createTwoTenants();

    await createBusiness(await requireWorkspaceContext(a.user, a.workspace.id), { name: 'Store' });
    await expect(
      createBusiness(await requireWorkspaceContext(b.user, b.workspace.id), { name: 'Store' }),
    ).resolves.toMatchObject({ name: 'Store' });
  });

  it('rejects a duplicate business name within one workspace', async () => {
    const { a } = await createTwoTenants();
    const context = await requireWorkspaceContext(a.user, a.workspace.id);

    await createBusiness(context, { name: 'Duplicate' });
    await expect(createBusiness(context, { name: 'Duplicate' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('assertBelongsToBusiness', () => {
  it('passes for a record in the same business', async () => {
    const { a } = await createTwoTenants();
    const context = await requireBusinessContext(a.user, a.business.id);

    expect(() =>
      assertBelongsToBusiness(context, { businessId: a.business.id }, 'Creative'),
    ).not.toThrow();
  });

  it('throws for a record from another business', async () => {
    const { a, b } = await createTwoTenants();
    const context = await requireBusinessContext(a.user, a.business.id);

    expect(() =>
      assertBelongsToBusiness(context, { businessId: b.business.id }, 'Creative'),
    ).toThrow(/different business/);
  });

  it('throws for a missing record', async () => {
    const { a } = await createTwoTenants();
    const context = await requireBusinessContext(a.user, a.business.id);

    expect(() => assertBelongsToBusiness(context, null, 'Creative')).toThrow(/not found/);
  });
});

describe('assertBelongsToWorkspace', () => {
  it('throws for a record from another workspace', async () => {
    const { a, b } = await createTwoTenants();
    const context = await requireWorkspaceContext(a.user, a.workspace.id);

    expect(() =>
      assertBelongsToWorkspace(context, { workspaceId: b.workspace.id }, 'Integration'),
    ).toThrow(/different workspace/);
  });
});

describe('roles', () => {
  it('ranks roles from VIEWER up to OWNER', () => {
    expect(hasAtLeastRole('OWNER', 'ADMIN')).toBe(true);
    expect(hasAtLeastRole('ADMIN', 'MEMBER')).toBe(true);
    expect(hasAtLeastRole('MEMBER', 'MEMBER')).toBe(true);
    expect(hasAtLeastRole('VIEWER', 'MEMBER')).toBe(false);
    expect(hasAtLeastRole('MEMBER', 'ADMIN')).toBe(false);
  });

  it('refuses an action when the member lacks the required role', async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner);
    const viewer = await createTestUser();
    await addMember(workspace, viewer, 'VIEWER');

    await expect(
      requireWorkspaceContext(viewer, workspace.id, { minimumRole: 'MEMBER' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('permits an action when the member has the required role', async () => {
    const owner = await createTestUser();
    const workspace = await createTestWorkspace(owner);
    const member = await createTestUser();
    await addMember(workspace, member, 'ADMIN');

    await expect(
      requireWorkspaceContext(member, workspace.id, { minimumRole: 'MEMBER' }),
    ).resolves.toMatchObject({ role: 'ADMIN' });
  });
});

describe('multiple businesses per user', () => {
  it('supports one user managing several businesses across workspaces', async () => {
    // §4: do not assume one user equals one business.
    const user = await createTestUser();
    const first = await createTestWorkspace(user, { name: 'Agency' });
    const second = await createTestWorkspace(user, { name: 'Side project' });

    await createTestBusiness(first, { name: 'Client One' });
    await createTestBusiness(first, { name: 'Client Two' });
    await createTestBusiness(second, { name: 'Own store' });

    const workspaces = await listWorkspacesForUser(user);
    expect(workspaces).toHaveLength(2);

    const firstBusinesses = await listBusinesses(await requireWorkspaceContext(user, first.id));
    const secondBusinesses = await listBusinesses(await requireWorkspaceContext(user, second.id));

    expect(firstBusinesses).toHaveLength(2);
    expect(secondBusinesses).toHaveLength(1);
  });
});

describe('unauthenticated access', () => {
  it('rejects a null user at the workspace boundary', async () => {
    const { a } = await createTwoTenants();
    await expect(requireWorkspaceContext(null, a.workspace.id)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });

  it('rejects a null user at the business boundary', async () => {
    const { a } = await createTwoTenants();
    await expect(requireBusinessContext(null, a.business.id)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
  });
});

describe('archived businesses', () => {
  it('are hidden from the default listing and from context resolution', async () => {
    const { a } = await createTwoTenants();
    await prisma.business.update({
      where: { id: a.business.id },
      data: { archivedAt: new Date() },
    });

    const context = await requireWorkspaceContext(a.user, a.workspace.id);
    expect(await listBusinesses(context)).toHaveLength(0);
    expect(await listBusinesses(context, { includeArchived: true })).toHaveLength(1);

    await expect(requireBusinessContext(a.user, a.business.id)).rejects.toMatchObject({
      code: 'TENANT_MISMATCH',
    });
    await expect(
      requireBusinessContext(a.user, a.business.id, { includeArchived: true }),
    ).resolves.toMatchObject({ businessId: a.business.id });
  });
});

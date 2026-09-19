import type { Business, User, Workspace, WorkspaceRole } from '@prisma/client';
import { prisma } from '@/lib/db';
import { hashPassword } from '@/server/auth/password';
import { slugify } from '@/lib/slug';

/**
 * Fixtures for database tests.
 *
 * `createTestBusiness` deliberately takes no industry defaults and no product
 * category: the fixtures for "Business A" and "Business B" in the isolation
 * tests are two arbitrary, unrelated businesses, which is the point — the
 * engine must not care what either of them sells.
 */

/** Wipes every table. Call in `beforeEach` so each test starts from empty. */
export async function resetDatabase(): Promise<void> {
  // Order matters only in that TRUNCATE ... CASCADE handles the FKs for us.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_logs,
      jobs,
      sessions,
      workspace_memberships,
      businesses,
      workspaces,
      users
    RESTART IDENTITY CASCADE
  `);
}

/** A fast scrypt cost, for tests only. Production parameters are 128x heavier. */
const TEST_SCRYPT_PARAMS = { N: 2 ** 10, r: 8, p: 1 } as const;

let uniqueCounter = 0;
const unique = (): string => `${Date.now().toString(36)}${(uniqueCounter += 1)}`;

export async function createTestUser(
  overrides: { email?: string; name?: string; password?: string } = {},
): Promise<User> {
  const suffix = unique();
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user-${suffix}@example.test`,
      name: overrides.name ?? `Test User ${suffix}`,
      passwordHash: await hashPassword(
        overrides.password ?? 'correct-horse-battery-staple',
        TEST_SCRYPT_PARAMS,
      ),
    },
  });
}

export async function createTestWorkspace(
  owner: User,
  overrides: { name?: string; role?: WorkspaceRole } = {},
): Promise<Workspace> {
  const name = overrides.name ?? `Workspace ${unique()}`;
  return prisma.workspace.create({
    data: {
      name,
      slug: `${slugify(name)}-${unique()}`,
      memberships: { create: { userId: owner.id, role: overrides.role ?? 'OWNER' } },
    },
  });
}

export async function createTestBusiness(
  workspace: Workspace,
  overrides: Partial<Pick<Business, 'name' | 'industry' | 'websiteUrl'>> = {},
): Promise<Business> {
  return prisma.business.create({
    data: {
      workspaceId: workspace.id,
      name: overrides.name ?? `Business ${unique()}`,
      industry: overrides.industry ?? null,
      websiteUrl: overrides.websiteUrl ?? null,
    },
  });
}

export async function addMember(
  workspace: Workspace,
  user: User,
  role: WorkspaceRole = 'MEMBER',
): Promise<void> {
  await prisma.workspaceMembership.create({
    data: { workspaceId: workspace.id, userId: user.id, role },
  });
}

/**
 * Two complete, unrelated tenants — the fixture the isolation tests are built
 * on. Nothing is shared between them: different owners, workspaces and
 * businesses in different industries.
 */
export async function createTwoTenants(): Promise<{
  a: { user: User; workspace: Workspace; business: Business };
  b: { user: User; workspace: Workspace; business: Business };
}> {
  const userA = await createTestUser({ name: 'Owner A' });
  const workspaceA = await createTestWorkspace(userA, { name: 'Tenant A' });
  const businessA = await createTestBusiness(workspaceA, {
    name: 'Alpine Coffee Roasters',
    industry: 'Specialty food and beverage',
    websiteUrl: 'https://alpine-coffee.example.com',
  });

  const userB = await createTestUser({ name: 'Owner B' });
  const workspaceB = await createTestWorkspace(userB, { name: 'Tenant B' });
  const businessB = await createTestBusiness(workspaceB, {
    name: 'Harbour Marine Supply',
    industry: 'Industrial equipment',
    websiteUrl: 'https://harbour-marine.example.com',
  });

  return {
    a: { user: userA, workspace: workspaceA, business: businessA },
    b: { user: userB, workspace: workspaceB, business: businessB },
  };
}

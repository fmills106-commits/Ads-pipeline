import { route } from '@/server/api/handler';
import { listWorkspacesForUser } from '@/server/tenancy/context';

/**
 * GET /api/workspaces — the workspaces the caller belongs to, with their role.
 *
 * This is the entry point a client uses before anything else: every other
 * tenant-scoped endpoint requires a workspace id, and this is the only
 * legitimate way to learn one.
 */
export const GET = route({}, async ({ user }) => {
  const workspaces = await listWorkspacesForUser(user);
  return workspaces.map(({ workspace, role }) => ({
    id: workspace.id,
    name: workspace.name,
    slug: workspace.slug,
    role,
    createdAt: workspace.createdAt.toISOString(),
  }));
});

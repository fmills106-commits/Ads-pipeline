import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getCurrentUser } from '@/server/auth/current-user';
import { listWorkspacesForUser } from '@/server/tenancy/context';
import { Sidebar } from './sidebar';
import { LogoutButton } from './logout-button';

/**
 * The authenticated shell.
 *
 * Auth is checked here rather than in middleware so the check runs against the
 * database (a revoked session must stop working immediately, which a cookie
 * check alone cannot guarantee).
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const workspaces = await listWorkspacesForUser(user);
  const active = workspaces[0];

  return (
    <div className="flex min-h-screen">
      <Sidebar
        workspaceName={active?.workspace.name ?? 'No workspace'}
        userName={user.name}
        userEmail={user.email}
        logout={<LogoutButton />}
      />
      <main className="flex-1 overflow-x-hidden px-6 py-8 md:px-10">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}

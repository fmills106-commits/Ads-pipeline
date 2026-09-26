import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getCurrentUser } from '@/server/auth/current-user';
import { listWorkspacesForUser } from '@/server/tenancy/context';
import { parseTheme, THEME_COOKIE } from '@/lib/theme';
import { Sidebar } from './sidebar';
import { LogoutButton } from './logout-button';
import { ThemeSwitch } from './theme-switch';

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
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar
        workspaceName={active?.workspace.name ?? 'No workspace'}
        userName={user.name}
        userEmail={user.email}
        logout={<LogoutButton />}
        appearance={<ThemeSwitch theme={parseTheme((await cookies()).get(THEME_COOKIE)?.value)} />}
      />
      <main className="min-w-0 flex-1 overflow-x-hidden px-4 py-8 sm:px-6 md:px-10">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}

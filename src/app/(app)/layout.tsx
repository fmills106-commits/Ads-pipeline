import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { getCurrentUser } from '@/server/auth/current-user';
import { resolveActiveBusiness } from '@/server/tenancy/active-business';
import { BusinessSwitcher } from './business-switcher';
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

  const { workspaceContext, businesses, business } = await resolveActiveBusiness(user);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Sidebar
        workspaceName={workspaceContext?.workspace.name ?? 'No workspace'}
        userName={user.name}
        userEmail={user.email}
        logout={<LogoutButton />}
        businessSwitcher={
          workspaceContext ? (
            <BusinessSwitcher businesses={businesses} activeId={business?.id ?? null} />
          ) : null
        }
      />
      <main className="min-w-0 flex-1 overflow-x-hidden px-4 py-8 sm:px-6 md:px-10">
        <div className="mx-auto w-full max-w-6xl">{children}</div>
      </main>
    </div>
  );
}

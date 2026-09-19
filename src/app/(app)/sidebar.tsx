'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { NAV_ITEMS } from '@/components/nav';
import { cx } from '@/components/ui/primitives';

export function Sidebar({
  workspaceName,
  userName,
  userEmail,
  logout,
}: {
  workspaceName: string;
  userName: string;
  userEmail: string;
  logout: ReactNode;
}) {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-surface-muted">
      <div className="border-b border-border-subtle px-5 py-5">
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">Ads Engine</p>
        <p className="mt-1 truncate text-sm font-medium" title={workspaceName}>
          {workspaceName}
        </p>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-3" aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

          if (!item.available) {
            return (
              <span
                key={item.href}
                className="flex cursor-not-allowed items-center justify-between rounded-md px-3 py-2 text-sm text-ink-muted opacity-60"
                title={`Arrives in Phase ${item.phase}`}
                aria-disabled="true"
              >
                {item.label}
                <span className="text-[10px] font-medium uppercase">P{item.phase}</span>
              </span>
            );
          }

          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'block rounded-md px-3 py-2 text-sm transition',
                active
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'text-ink hover:bg-surface hover:text-accent',
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border-subtle p-4">
        <p className="truncate text-sm font-medium" title={userName}>
          {userName}
        </p>
        <p className="mb-3 truncate text-xs text-ink-muted" title={userEmail}>
          {userEmail}
        </p>
        {logout}
      </div>
    </aside>
  );
}

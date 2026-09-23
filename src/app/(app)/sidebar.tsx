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

  /**
   * One element, two shapes. Below `md` it is a top bar with a horizontally
   * scrollable nav, because a 240px rail on a 390px screen leaves no room for
   * the content it is meant to navigate. From `md` up it is the usual left
   * rail. No JavaScript drawer: a five-item nav does not need one.
   */
  return (
    <aside className="flex shrink-0 flex-col border-b border-border-subtle bg-surface-muted md:w-60 md:border-b-0 md:border-r">
      <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-5 py-4 md:block md:py-5">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-widest text-accent">Ads Engine</p>
          <p className="mt-1 truncate text-sm font-medium" title={workspaceName}>
            {workspaceName}
          </p>
        </div>
        {/* On a phone the footer block below is hidden, so sign-out lives here. */}
        <div className="shrink-0 md:hidden">{logout}</div>
      </div>

      <nav
        className="flex gap-1 overflow-x-auto p-3 md:flex-1 md:flex-col md:gap-0.5 md:overflow-x-visible md:overflow-y-auto"
        aria-label="Primary"
      >
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

          if (!item.available) {
            return (
              <span
                key={item.href}
                className="flex shrink-0 cursor-not-allowed items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm text-ink-muted opacity-60 md:justify-between"
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
                'shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm transition',
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

      <div className="hidden border-t border-border-subtle p-4 md:block">
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

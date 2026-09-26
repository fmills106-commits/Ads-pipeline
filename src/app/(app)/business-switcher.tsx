import Link from 'next/link';
import { switchBusiness } from '@/app/actions/business';
import { cx } from '@/components/ui/primitives';
import type { Business } from '@prisma/client';

/**
 * Which website you are looking at, and how to add another.
 *
 * Hidden entirely with one business, which is the common case and does not
 * need a chooser. With two or more it is the first thing in the rail, because
 * everything below it means something different depending on this answer.
 *
 * A form of submit buttons rather than a dropdown: no client component, works
 * without JavaScript, and the current choice is readable rather than hidden
 * behind a click.
 */
export function BusinessSwitcher({
  businesses,
  activeId,
}: {
  businesses: Business[];
  activeId: string | null;
}) {
  if (businesses.length <= 1) {
    return (
      <Link
        href="/setup?another=1"
        className="mt-3 block text-xs text-accent underline-offset-2 hover:underline"
      >
        Add another website
      </Link>
    );
  }

  return (
    <div className="mt-3">
      <form action={switchBusiness}>
        <fieldset>
          <legend className="mb-1.5 text-xs font-medium text-ink-muted">Website</legend>
          <div className="space-y-0.5">
            {businesses.map((business) => {
              const active = business.id === activeId;
              return (
                <button
                  key={business.id}
                  type="submit"
                  name="businessId"
                  value={business.id}
                  aria-current={active ? 'true' : undefined}
                  title={business.websiteUrl ?? business.name}
                  className={cx(
                    'block w-full truncate rounded px-2 py-1 text-left text-sm transition',
                    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                    active
                      ? 'bg-accent-soft font-medium text-accent'
                      : 'text-ink-muted hover:bg-surface hover:text-ink',
                  )}
                >
                  {business.name}
                </button>
              );
            })}
          </div>
        </fieldset>
      </form>

      <Link
        href="/setup?another=1"
        className="mt-2 block text-xs text-accent underline-offset-2 hover:underline"
      >
        Add another website
      </Link>
    </div>
  );
}

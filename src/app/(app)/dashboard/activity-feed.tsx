import type { ActivityItem } from '@/server/activity/feed';
import { cx } from '@/components/ui/primitives';

/**
 * The activity feed.
 *
 * Deliberately not a log viewer. No timestamps to the second, no correlation
 * ids, no levels — a sentence, an icon, and roughly when. The full technical
 * record lives in the audit log for whoever needs it.
 */
export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  if (items.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-ink-muted">
        Nothing yet. Once your website is scanned, everything the AI does shows up here.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {items.map((item) => (
        <li key={item.id} className="flex items-start gap-3">
          <span className="mt-0.5 text-base" aria-hidden="true">
            {item.icon}
          </span>
          <div className="min-w-0 flex-1">
            <p className={cx('text-sm', item.needsAttention ? 'font-medium text-ink' : 'text-ink')}>
              {item.message}
            </p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {relativeTime(item.createdAt)}
              {item.needsAttention ? ' · needs your input' : ''}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** "3 minutes ago" beats an ISO timestamp for someone glancing at their ads. */
function relativeTime(when: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - when.getTime()) / 1000);
  if (seconds < 60) return 'just now';

  const units: Array<[label: string, seconds: number]> = [
    ['minute', 60],
    ['hour', 3_600],
    ['day', 86_400],
    ['week', 604_800],
    ['month', 2_592_000],
  ];

  let best: [string, number] = units[0]!;
  for (const unit of units) {
    if (seconds >= unit[1]) best = unit;
  }

  const count = Math.floor(seconds / best[1]);
  return `${count} ${best[0]}${count === 1 ? '' : 's'} ago`;
}

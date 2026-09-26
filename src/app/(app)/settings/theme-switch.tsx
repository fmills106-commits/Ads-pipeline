import { setTheme } from '@/app/actions/theme';
import { cx } from '@/components/ui/primitives';
import { THEME_LABELS, THEMES, type Theme } from '@/lib/theme';

/**
 * Light / Dark / Match my device.
 *
 * Three visible options rather than a two-state toggle, because a toggle
 * cannot express "follow my device" — and that is the default, so a toggle
 * would have to either hide it or lie about the current state.
 *
 * A form with three submit buttons: no client component, no JavaScript needed,
 * and each button is a real control a screen reader and a keyboard already
 * understand.
 *
 * Lives in Settings rather than the navigation rail. It was in the rail first,
 * which put a preference nobody changes twice next to the five things people
 * use constantly — and the owner asked for it tucked away.
 */
export function ThemeSwitch({ theme }: { theme: Theme }) {
  return (
    <form action={setTheme}>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-ink-muted">Appearance</legend>
        <div
          className="flex gap-1 rounded-md border border-border-subtle bg-surface p-0.5"
          role="group"
        >
          {THEMES.map((option) => {
            const active = option === theme;
            return (
              <button
                key={option}
                type="submit"
                name="theme"
                value={option}
                aria-pressed={active}
                title={THEME_LABELS[option]}
                className={cx(
                  'flex-1 rounded px-2 py-1 text-xs transition',
                  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                  active
                    ? 'bg-accent-soft font-medium text-accent'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                {SHORT_LABELS[option]}
              </button>
            );
          })}
        </div>
      </fieldset>
    </form>
  );
}

/** Short labels keep the three options on one line at phone width. */
const SHORT_LABELS: Record<Theme, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

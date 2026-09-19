import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/**
 * The small set of presentational primitives the shell is built from.
 *
 * Kept deliberately minimal — this is Phase 1. The pieces that matter for
 * later phases (the fact-vs-inference distinction, creative status badges)
 * are here because their visual language needs to be settled before the
 * screens that use them are written, not after.
 */

export function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export function Card({
  children,
  className,
  ...rest
}: ComponentPropsWithoutRef<'section'>): ReactNode {
  return (
    <section
      className={cx('rounded-lg border border-border-subtle bg-surface p-5 shadow-sm', className)}
      {...rest}
    >
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): ReactNode {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

type ButtonVariant = 'primary' | 'secondary' | 'danger';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:opacity-90',
  secondary: 'border border-border-subtle bg-surface text-ink hover:bg-surface-muted',
  danger: 'bg-status-danger text-white hover:opacity-90',
};

export function Button({
  variant = 'primary',
  className,
  ...rest
}: ComponentPropsWithoutRef<'button'> & { variant?: ButtonVariant }): ReactNode {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium transition',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON_STYLES[variant],
        className,
      )}
      {...rest}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && !error ? <span className="mt-1 block text-xs text-ink-muted">{hint}</span> : null}
      {error ? (
        <span className="mt-1 block text-xs text-status-danger" role="alert">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export function Input({ className, ...rest }: ComponentPropsWithoutRef<'input'>): ReactNode {
  return (
    <input
      className={cx(
        'w-full rounded-md border border-border-subtle bg-surface px-3 py-2 text-sm',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
        className,
      )}
      {...rest}
    />
  );
}

/**
 * The verified-fact / AI-inference distinction from §7, as a visual primitive.
 *
 * Defined now so that every later screen has one way to express it, and an
 * AI assumption can never be rendered with the same styling as a fact scraped
 * from the merchant's own page.
 */
export function Provenance({ kind }: { kind: 'verified' | 'inferred' }): ReactNode {
  const verified = kind === 'verified';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        verified
          ? 'bg-status-ok/10 text-status-ok'
          : 'border border-dashed border-status-pending text-status-pending',
      )}
      title={
        verified
          ? 'Extracted from the source website and traceable to a URL.'
          : 'An AI hypothesis. Not a verified business fact.'
      }
    >
      {verified ? 'Verified' : 'AI inference'}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="rounded-lg border border-dashed border-border-subtle p-10 text-center">
      <p className="font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-ink-muted">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-accent">
            AI Advertising Engine
          </p>
          <p className="mt-2 text-sm text-ink-muted">
            Website in. Understood products, strategy, creative and measured campaigns out.
          </p>
        </div>
        {children}
      </div>
    </main>
  );
}

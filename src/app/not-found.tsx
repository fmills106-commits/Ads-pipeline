import Link from 'next/link';

/**
 * The 404 page.
 *
 * The default one says "404 — This page could not be found" in Times New
 * Roman on a white background, which after a theme switch looks like the
 * application has crashed rather than that a link is stale.
 *
 * It reassures rather than apologises, because the likeliest way an owner
 * reaches this page is a bookmark to something that was removed — a business,
 * a website, a product — and the question that follows is "have I broken
 * something expensive?"
 */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-16">
      <p className="text-xs font-semibold uppercase tracking-widest text-accent">Ads Engine</p>
      <h1 className="mt-2 text-2xl font-semibold">We couldn&rsquo;t find that page</h1>
      <p className="mt-3 text-sm text-ink-muted">
        It may have been removed, or the link may be out of date. Nothing is wrong with your
        account, and no advertising has been affected.
      </p>
      <div className="mt-6 flex gap-3">
        <Link
          href="/dashboard"
          className="inline-flex rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white"
        >
          Go to my dashboard
        </Link>
      </div>
    </main>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { Card, EmptyState, PageHeader, Provenance, cx } from '@/components/ui/primitives';
import { requireCurrentUser } from '@/server/auth/current-user';
import {
  listWorkspacesForUser,
  requireBusinessContext,
  requireWorkspaceContext,
} from '@/server/tenancy/context';
import { listBusinesses } from '@/server/business/service';
import { getScanStatus, getWebsiteKnowledge } from '@/server/scanner/service';
import { formatCents } from '@/lib/budget';
import { ScanControl } from './scan-control';
import { WebsiteAddress } from './website-address';

export const metadata: Metadata = { title: 'Website' };

/**
 * What the scanner learned.
 *
 * The organising idea is the fact/inference distinction: everything on this
 * page is a VERIFIED fact taken from the merchant's own site, each with the
 * URL it came from. When Phase 3 adds AI inferences they render differently
 * and live in their own section — a visitor must never have to guess which
 * they are looking at.
 */
export default async function WebsitePage() {
  const user = await requireCurrentUser();
  const workspaces = await listWorkspacesForUser(user);
  const active = workspaces[0];
  if (!active)
    return <EmptyState title="No workspace" description="Your account has no workspace." />;

  const workspaceContext = await requireWorkspaceContext(user, active.workspace.id);
  const businesses = await listBusinesses(workspaceContext);
  const business = businesses[0];

  if (!business) {
    return (
      <EmptyState
        title="No business yet"
        description="Add your business first, then we can read its website."
        action={
          <Link
            href="/setup"
            className="inline-flex rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white"
          >
            Set up
          </Link>
        }
      />
    );
  }

  const context = await requireBusinessContext(user, business.id);
  const [status, knowledge] = await Promise.all([
    getScanStatus(context),
    getWebsiteKnowledge(context),
  ]);

  const hasWebsite = Boolean(business.websiteUrl);

  return (
    <>
      <PageHeader
        title="Your website"
        description="What we read from your site. Everything here came from your own pages — nothing is invented."
        actions={
          hasWebsite ? <ScanControl businessId={business.id} initialPhase={status.phase} /> : null
        }
      />

      <WebsiteAddress
        businessId={business.id}
        websiteUrl={business.websiteUrl}
        knowledge={{ products: knowledge.products.length, facts: knowledge.factCount }}
      />

      {!hasWebsite ? (
        <EmptyState
          title="No website address"
          description="Add your website above and we can read it to learn what you sell."
        />
      ) : null}

      {status.phase === 'failed' && status.scanRun?.error ? (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-status-danger/30 bg-status-danger/5 p-4">
          <span aria-hidden="true">⚠️</span>
          <p className="text-sm">
            <strong>We couldn&rsquo;t read your website.</strong>{' '}
            <span className="text-ink-muted">
              {(status.scanRun.error as { message?: string }).message ?? 'Please try again.'}
            </span>
          </p>
        </div>
      ) : null}

      {status.scanRun?.status === 'PARTIAL' ? (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-status-pending/40 bg-status-pending/5 p-4">
          <span aria-hidden="true">ℹ️</span>
          <p className="text-sm text-ink-muted">
            We read as much as we could in one pass ({status.scanRun.stopReason?.replace('-', ' ')}
            ). What&rsquo;s below is accurate; there may simply be more of it.
          </p>
        </div>
      ) : null}

      {hasWebsite && status.phase === 'idle' ? (
        <EmptyState
          title="Not read yet"
          description="Press “Read my website” and we'll go through your pages, find your products, and note what they say."
        />
      ) : null}

      {knowledge.website ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label="Pages read" value={String(status.pagesFetched)} />
            <Figure label="Products found" value={String(knowledge.products.length)} />
            <Figure label="Verified facts" value={String(knowledge.factCount)} />
            <Figure
              label="Last read"
              value={
                knowledge.website.lastScanAt ? relativeTime(knowledge.website.lastScanAt) : '—'
              }
            />
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem]">
            <div className="space-y-6">
              <Card>
                <div className="mb-4 flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Products</h2>
                  <Provenance kind="verified" />
                </div>

                {knowledge.products.length === 0 ? (
                  <p className="py-4 text-sm text-ink-muted">
                    No products found. If your products are on a different part of the site, check
                    the address above.
                  </p>
                ) : (
                  <ul className="divide-y divide-border-subtle">
                    {knowledge.products.map((product) => (
                      <li key={product.id} className="flex items-start gap-3 py-3 first:pt-0">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{product.name}</p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
                            {product.priceCents !== null ? (
                              <span className="font-medium text-ink tabular-nums">
                                {formatCents(product.priceCents, product.currency ?? 'USD')}
                              </span>
                            ) : (
                              <span>No price found</span>
                            )}
                            {product.comparePriceCents !== null ? (
                              <span className="line-through tabular-nums">
                                {formatCents(product.comparePriceCents, product.currency ?? 'USD')}
                              </span>
                            ) : null}
                            <AvailabilityBadge availability={product.availability} />
                            {product._count.versions > 1 ? (
                              <span className="text-xs">
                                {product._count.versions} versions recorded
                              </span>
                            ) : null}
                          </p>
                          <StatedOffers offers={product.statedOffers} />

                          <a
                            href={product.productUrl}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="mt-1 block truncate text-xs text-accent hover:underline"
                          >
                            {product.productUrl}
                          </a>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card>
                <div className="mb-1 flex items-center gap-2">
                  <h2 className="text-sm font-semibold">What we know about your business</h2>
                  <Provenance kind="verified" />
                </div>
                <p className="mb-4 text-sm text-ink-muted">
                  Each of these came from a specific page. Hover a row to see where.
                </p>

                {knowledge.facts.length === 0 ? (
                  <p className="text-sm text-ink-muted">Nothing extracted yet.</p>
                ) : (
                  <dl className="space-y-2 text-sm">
                    {knowledge.facts.slice(0, 30).map((fact) => (
                      <div
                        key={fact.id}
                        className="grid gap-1 sm:grid-cols-[12rem_1fr]"
                        title={fact.sourceUrl}
                      >
                        <dt className="text-ink-muted">{humaniseKey(fact.key)}</dt>
                        <dd className="flex items-start gap-2">
                          <span className="min-w-0 break-words">{fact.value}</span>
                          <ConfidenceDot confidence={fact.confidence} method={fact.method} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </Card>
            </div>

            <div className="space-y-6">
              <Card className="h-fit">
                <h2 className="mb-3 text-sm font-semibold">Pages</h2>
                <ul className="space-y-1.5 text-sm">
                  {Object.entries(knowledge.pageTypeCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([type, count]) => (
                      <li key={type} className="flex justify-between gap-3">
                        <span className="text-ink-muted">{humanisePageType(type)}</span>
                        <span className="tabular-nums">{count}</span>
                      </li>
                    ))}
                </ul>
              </Card>

              {status.warnings.length > 0 ? (
                <Card className="h-fit">
                  <h2 className="mb-1 text-sm font-semibold">Pages we skipped</h2>
                  <p className="mb-3 text-sm text-ink-muted">
                    Normal on most sites — usually pages your robots.txt asks crawlers to leave
                    alone.
                  </p>
                  <ul className="space-y-1.5 text-xs">
                    {status.warnings.slice(0, 8).map((warning, index) => (
                      <li key={`${warning.url}-${index}`} className="truncate" title={warning.url}>
                        <span className="text-ink-muted">{humaniseReason(warning.reason)}</span>{' '}
                        {shortenUrl(warning.url)}
                      </li>
                    ))}
                  </ul>
                </Card>
              ) : null}

              <Card className="h-fit">
                <h2 className="mb-2 text-sm font-semibold">Source</h2>
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="text-ink-muted">Address</dt>
                    <dd className="truncate">
                      {knowledge.website.resolvedRootUrl ?? knowledge.website.rootUrl}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">robots.txt</dt>
                    <dd>{knowledge.website.robotsTxt ? 'Found and respected' : 'None found'}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">Sitemap</dt>
                    <dd>
                      {knowledge.website.sitemapUrls.length > 0
                        ? `${knowledge.website.sitemapUrls.length} used`
                        : 'None found'}
                    </dd>
                  </div>
                </dl>
              </Card>
            </div>
          </div>
        </>
      ) : null}
    </>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}

function AvailabilityBadge({ availability }: { availability: string }) {
  if (availability === 'UNKNOWN') return null;
  const inStock = availability === 'IN_STOCK';
  return (
    <span
      className={cx(
        'rounded-full px-2 py-0.5 text-xs font-medium',
        inStock ? 'bg-status-ok/10 text-status-ok' : 'bg-status-pending/10 text-status-pending',
      )}
    >
      {inStock ? 'In stock' : availability === 'PREORDER' ? 'Pre-order' : 'Out of stock'}
    </span>
  );
}

/**
 * Promotions the page states in so many words.
 *
 * Shown in the site's own words rather than normalised to "15% off", because
 * a discount the owner does not recognise is how they find out a page still
 * carries last month's sale. Nothing here is computed: `sourceText` is the
 * phrase the extractor matched, quoted back.
 */
function StatedOffers({ offers }: { offers: unknown }) {
  if (!Array.isArray(offers) || offers.length === 0) return null;

  const texts = offers
    .map((offer) =>
      typeof offer === 'object' && offer !== null && 'sourceText' in offer
        ? String((offer as { sourceText: unknown }).sourceText)
        : null,
    )
    .filter((text): text is string => text !== null && text.length > 0)
    .slice(0, 3);

  if (texts.length === 0) return null;

  return (
    <p className="mt-1 flex flex-wrap items-center gap-2">
      {texts.map((text) => (
        <span
          key={text}
          className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent"
          title="This wording appears on your page"
        >
          “{text}”
        </span>
      ))}
    </p>
  );
}

/**
 * How firmly a fact is held, shown as a dot rather than a number.
 *
 * "0.95" means nothing to a business owner; "this came from structured data
 * the site publishes" does, and that is what the tooltip says.
 */
function ConfidenceDot({ confidence, method }: { confidence: number; method: string }) {
  const strong = confidence >= 0.85;
  return (
    <span
      className={cx(
        'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
        strong ? 'bg-status-ok' : 'bg-status-pending',
      )}
      title={`${strong ? 'High confidence' : 'Lower confidence'} — read from ${humaniseMethod(method)}`}
      aria-label={strong ? 'High confidence' : 'Lower confidence'}
    />
  );
}

function humaniseKey(key: string): string {
  const labels: Record<string, string> = {
    'business.name': 'Business name',
    'business.description': 'Description',
    'contact.email': 'Email',
    'contact.phone': 'Phone',
    'contact.address': 'Address',
    'policy.shipping_url': 'Shipping page',
    'policy.returns_url': 'Returns page',
    'policy.faq_url': 'FAQ page',
    'page.contact_url': 'Contact page',
    'page.about_url': 'About page',
    'social.profile': 'Social profile',
  };
  return labels[key] ?? key.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function humaniseMethod(method: string): string {
  const labels: Record<string, string> = {
    JSON_LD: 'structured data your site publishes',
    MICRODATA: 'markup annotations on the page',
    OPENGRAPH: 'social preview tags',
    HTML: 'the page markup',
    TEXT_PATTERN: 'the visible text',
    MERCHANT_PROVIDED: 'what you told us',
  };
  return labels[method] ?? method;
}

function humanisePageType(type: string): string {
  const labels: Record<string, string> = {
    HOME: 'Home',
    PRODUCT: 'Product pages',
    COLLECTION: 'Category pages',
    ABOUT: 'About',
    FAQ: 'FAQ',
    SHIPPING: 'Shipping',
    RETURNS: 'Returns',
    CONTACT: 'Contact',
    POLICY: 'Policies',
    BLOG: 'Blog',
    OTHER: 'Other',
  };
  return labels[type] ?? type;
}

function humaniseReason(reason: string): string {
  if (reason === 'robots-disallowed') return 'Your robots.txt excludes';
  if (reason === 'too-large') return 'Too large:';
  if (reason === 'unsupported-content-type') return 'Not a page:';
  if (reason === 'instruction-like-text') return 'Unusual text on';
  if (reason.startsWith('http-')) return `Returned ${reason.slice(5)}:`;
  return 'Skipped:';
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname === '/' ? parsed.hostname : parsed.pathname;
  } catch {
    return url;
  }
}

function relativeTime(when: Date, now: Date = new Date()): string {
  const seconds = Math.round((now.getTime() - when.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const units: Array<[string, number]> = [
    ['minute', 60],
    ['hour', 3_600],
    ['day', 86_400],
    ['week', 604_800],
  ];
  let best: [string, number] = units[0]!;
  for (const unit of units) if (seconds >= unit[1]) best = unit;
  const count = Math.floor(seconds / best[1]);
  return `${count} ${best[0]}${count === 1 ? '' : 's'} ago`;
}

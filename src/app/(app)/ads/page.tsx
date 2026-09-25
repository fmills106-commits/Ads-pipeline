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
import { getAnalysis } from '@/server/marketing/analysis';
import { prisma } from '@/lib/db';
import { formatCents } from '@/lib/budget';
import { MarketingControl } from './marketing-control';

export const metadata: Metadata = { title: 'Ads' };

/**
 * What the engine has worked out, and what it wrote.
 *
 * The page is organised around one distinction the owner must never have to
 * guess at: which of this was *read* off their website and which was
 * *concluded*. Verified facts live on the Website page under a green badge;
 * everything here is a conclusion, and says so. Where the free provider
 * produced it, that is stated in the first sentence rather than a footnote.
 *
 * There are no images yet — Phase 4 makes those. This is the text.
 */
export default async function AdsPage() {
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
        description="Add your business first."
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
  const [{ profile, inferences, decision }, products, strategies, copies, offers] =
    await Promise.all([
      getAnalysis(context),
      prisma.product.findMany({
        where: { businessId: context.businessId, removedAt: null },
        orderBy: { lastSeenAt: 'desc' },
        take: 20,
        select: { id: true, name: true },
      }),
      prisma.marketingStrategy.findMany({
        where: { businessId: context.businessId, archivedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 12,
        include: { product: { select: { name: true } } },
      }),
      prisma.adCopy.findMany({
        where: { businessId: context.businessId },
        orderBy: { createdAt: 'desc' },
        take: 12,
        include: { product: { select: { name: true } }, strategy: { select: { angle: true } } },
      }),
      prisma.offer.findMany({
        where: { businessId: context.businessId },
        orderBy: { createdAt: 'desc' },
        take: 10,
        include: { product: { select: { name: true } } },
      }),
    ]);

  const hasProducts = products.length > 0;
  const simulated = decision?.simulated ?? true;

  return (
    <>
      <PageHeader
        title="Your ads"
        description="What we worked out about how to advertise you, and the ad text itself. Everything here is a conclusion, not something read off your site."
        actions={
          hasProducts ? (
            <MarketingControl
              businessId={business.id}
              action="analyse"
              label={profile ? 'Think again' : 'Understand my business'}
              busyLabel="Thinking…"
            />
          ) : undefined
        }
      />

      {!hasProducts ? (
        <EmptyState
          title="Read your website first"
          description="We need to know what you sell before we can work out how to advertise it."
          action={
            <Link
              href="/website"
              className="inline-flex rounded-md bg-accent px-5 py-2.5 text-sm font-medium text-white"
            >
              Go to Website
            </Link>
          }
        />
      ) : null}

      {hasProducts && profile && simulated ? (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-border-subtle bg-surface-muted p-4">
          <span aria-hidden="true">🧪</span>
          <p className="text-sm text-ink-muted">
            <strong className="text-ink">This is a placeholder, not a recommendation.</strong> It
            was written by the free built-in generator, which does not use a language model. It
            shows you the shape of what you will get. Connect an AI provider in Settings for real
            analysis.
          </p>
        </div>
      ) : null}

      {hasProducts && !profile ? (
        <EmptyState
          title="Not thought about yet"
          description="Press “Understand my business” and we'll read what the scanner found and work out who might want it."
        />
      ) : null}

      {profile ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div className="space-y-6">
            <Card>
              <div className="mb-3 flex items-center gap-2">
                <h2 className="text-sm font-semibold">What we think you sell</h2>
                <Provenance kind="inferred" />
              </div>
              <p className="text-sm">{profile.valueProposition}</p>
              <dl className="mt-4 space-y-2 border-t border-border-subtle pt-4 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-muted">Tone of voice</dt>
                  <dd>{profile.brandVoice}</dd>
                </div>
                {profile.restrictions.length > 0 ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-muted">Words we avoid</dt>
                    <dd className="text-right">{profile.restrictions.join(', ')}</dd>
                  </div>
                ) : null}
              </dl>
            </Card>

            <Card>
              <div className="mb-1 flex items-center gap-2">
                <h2 className="text-sm font-semibold">Who might buy</h2>
                <Provenance kind="inferred" />
              </div>
              <p className="mb-4 text-sm text-ink-muted">
                Ideas to test, not findings. Nothing here has been measured yet.
              </p>

              {inferences.length === 0 ? (
                <p className="text-sm text-ink-muted">Nothing yet.</p>
              ) : (
                <ul className="space-y-3">
                  {inferences.map((inference) => (
                    <li
                      key={inference.id}
                      className="border-t border-border-subtle pt-3 first:border-0 first:pt-0"
                    >
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {inference.statement}
                        <ConfidenceTag uncertainty={inference.uncertainty} />
                      </p>
                      <p className="mt-1 text-sm text-ink-muted">{inference.reasoning}</p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Ad text</h2>
                  <Provenance kind="inferred" />
                </div>
                {strategies[0] ? (
                  <MarketingControl
                    businessId={business.id}
                    action="copy"
                    label="Write ads"
                    busyLabel="Writing…"
                    variant="secondary"
                    payload={{ strategyId: strategies[0].id }}
                  />
                ) : null}
              </div>

              {copies.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  No ad text yet. Pick an approach below, then press “Write ads”.
                </p>
              ) : (
                <ul className="space-y-4">
                  {copies.map((copy) => (
                    <li key={copy.id} className="rounded-lg border border-border-subtle p-3">
                      <p className="mb-1 flex items-center gap-2 text-xs text-ink-muted">
                        <span className="rounded bg-surface-muted px-1.5 py-0.5 font-medium">
                          {copy.variantLabel}
                        </span>
                        {copy.product.name} · {copy.strategy.angle.toLowerCase().replace('_', '/')}
                      </p>
                      <p className="font-medium">{copy.headline}</p>
                      <p className="mt-1 text-sm">{copy.primaryText}</p>
                      <p className="mt-1 text-sm text-ink-muted">{copy.description}</p>
                      <p className="mt-2 inline-flex rounded bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                        {copy.cta}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Ways to advertise</h2>
                  <Provenance kind="inferred" />
                </div>
                {products[0] ? (
                  <MarketingControl
                    businessId={business.id}
                    action="strategies"
                    label="Work out approaches"
                    busyLabel="Working…"
                    variant="secondary"
                    payload={{ productId: products[0].id }}
                  />
                ) : null}
              </div>

              {strategies.length === 0 ? (
                <p className="text-sm text-ink-muted">Nothing worked out yet.</p>
              ) : (
                <ul className="space-y-3">
                  {strategies.map((strategy) => (
                    <li
                      key={strategy.id}
                      className="border-t border-border-subtle pt-3 first:border-0 first:pt-0"
                    >
                      <p className="text-sm font-medium">
                        {strategy.hook}{' '}
                        <span className="font-normal text-ink-muted">
                          — {strategy.product?.name ?? 'your business'}
                        </span>
                      </p>
                      <p className="mt-1 text-sm text-ink-muted">{strategy.hypothesis}</p>
                      {strategy.assumptions.length > 0 ? (
                        <p className="mt-1 text-xs text-ink-muted">
                          Assumes: {strategy.assumptions.join('; ')}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-sm font-semibold">Offers</h2>
                <MarketingControl
                  businessId={business.id}
                  action="offers"
                  label="Suggest offers"
                  busyLabel="Working…"
                  variant="secondary"
                />
              </div>

              {offers.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  No offers suggested. Nothing goes live without you approving it.
                </p>
              ) : (
                <ul className="space-y-3 text-sm">
                  {offers.map((offer) => (
                    <li
                      key={offer.id}
                      className="border-t border-border-subtle pt-3 first:border-0 first:pt-0"
                    >
                      <p className="font-medium">{offer.product?.name ?? 'Your shop'}</p>
                      <p className="text-ink-muted">
                        {offer.type === 'PERCENT_OFF' ? `${offer.value}% off` : null}
                        {offer.type === 'FREE_SHIPPING' ? 'Free shipping' : null}
                        {offer.resultingPriceCents !== null
                          ? ` → ${formatCents(offer.resultingPriceCents, business.currency)}`
                          : null}
                      </p>
                      <p
                        className={cx(
                          'mt-1 text-xs',
                          offer.marginKnown ? 'text-ink-muted' : 'text-status-pending',
                        )}
                      >
                        {offer.marginKnown
                          ? `Your margin: ${formatCents(offer.estimatedMarginCents ?? 0, business.currency)}`
                          : 'Margin unknown — you have not told us what this costs you'}
                      </p>
                      <p className="mt-1 text-xs uppercase tracking-wide text-ink-muted">
                        {offer.status.toLowerCase()}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <h2 className="mb-2 text-sm font-semibold">What happens next</h2>
              <p className="text-sm text-ink-muted">
                Images and finished creatives arrive in the next phase, and running these as real
                ads comes after that. Until then this is text you can copy and use yourself.
              </p>
            </Card>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Uncertainty as a word, matching how the scanner shows confidence.
 *
 * "High uncertainty" said plainly beats a number that implies somebody
 * measured something.
 */
function ConfidenceTag({ uncertainty }: { uncertainty: string }) {
  const label =
    uncertainty === 'LOW' ? 'fairly confident' : uncertainty === 'HIGH' ? 'a guess' : 'unsure';

  return (
    <span className="rounded-full border border-dashed border-border-subtle px-2 py-0.5 text-xs font-normal text-ink-muted">
      {label}
    </span>
  );
}

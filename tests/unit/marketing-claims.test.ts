import { describe, expect, it } from 'vitest';
import { checkClaims, type ClaimEvidence } from '@/server/marketing/claims';

/**
 * The claim checker decides what a merchant's customers are told, so these
 * tests are written from the direction of the harm: each one names something
 * that would embarrass or expose the merchant if it shipped.
 */

const evidence = (overrides: Partial<ClaimEvidence> = {}): ClaimEvidence => ({
  statedPriceCents: [1800],
  currency: 'GBP',
  allowedDiscountPercents: [],
  verifiedText: 'Live sourdough starter. A 100-year-old rye culture, fed daily.',
  restrictions: [],
  hasActiveOffer: false,
  ...overrides,
});

const copy = (overrides: Partial<Parameters<typeof checkClaims>[0]> = {}) => ({
  primaryText: 'A 100-year-old rye culture, fed daily.',
  headline: 'Live sourdough starter',
  description: 'Shipped dormant.',
  cta: 'Shop now',
  ...overrides,
});

describe('copy that only repeats the website', () => {
  it('passes', () => {
    expect(checkClaims(copy(), evidence()).ok).toBe(true);
  });

  it('passes when it quotes the stated price', () => {
    const result = checkClaims(copy({ description: 'Just £18.00.' }), evidence());
    expect(result.violations).toEqual([]);
  });
});

describe('prices', () => {
  it('refuses a price the page does not state', () => {
    // The specific harm: a customer clicks through to a different number.
    const result = checkClaims(copy({ headline: 'Now only £9.99' }), evidence());

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.rule).toBe('unstated-price');
    expect(result.violations[0]?.excerpt).toBe('£9.99');
  });

  it('accepts a compare-at price the page also states', () => {
    const result = checkClaims(
      copy({ primaryText: 'Was £32.00, now £24.00.' }),
      evidence({ statedPriceCents: [2400, 3200] }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('discounts', () => {
  it('refuses one with no approved offer behind it', () => {
    const result = checkClaims(copy({ headline: '20% off today' }), evidence());

    expect(result.violations.some((v) => v.rule === 'unsupported-discount')).toBe(true);
  });

  it('accepts one that matches the approved offer', () => {
    const result = checkClaims(
      copy({ headline: '15% off' }),
      evidence({ allowedDiscountPercents: [15], hasActiveOffer: true }),
    );
    expect(result.violations.some((v) => v.rule === 'unsupported-discount')).toBe(false);
  });

  it('refuses a bigger discount than the one approved', () => {
    // The dangerous near-miss: an approved offer exists, so a careless check
    // would wave this through.
    const result = checkClaims(
      copy({ headline: '50% off' }),
      evidence({ allowedDiscountPercents: [15], hasActiveOffer: true }),
    );

    expect(result.ok).toBe(false);
    expect(result.violations[0]?.detail).toMatch(/does not match the approved offer/);
  });
});

describe('unprovable assertions', () => {
  const cases: Array<[string, string]> = [
    ['The best sourdough starter anywhere', 'unsubstantiated-superlative'],
    ['Rated 4.8 stars by 2,000 customers', 'unverifiable-statistic'],
    ['Only 3 left — ends tonight', 'manufactured-urgency'],
    ['Clinically proven to improve digestion', 'regulated-promise'],
    ['Risk-free, money-back guarantee', 'regulated-promise'],
  ];

  for (const [text, rule] of cases) {
    it(`refuses "${text}"`, () => {
      const result = checkClaims(copy({ primaryText: text }), evidence());
      expect(result.violations.map((v) => v.rule)).toContain(rule);
    });
  }

  it('allows a phrase the merchant published themselves', () => {
    // Their claim to make, not ours to block. Blocking it would make the
    // checker an editor rather than a fact-checker.
    const result = checkClaims(
      copy({ primaryText: 'Our best seller, as it says on the site.' }),
      evidence({ verifiedText: 'Our best seller since 2011.' }),
    );
    expect(result.violations.some((v) => v.rule === 'unsubstantiated-superlative')).toBe(false);
  });
});

describe('merchant restrictions', () => {
  it('refuses wording the merchant asked us not to use', () => {
    const result = checkClaims(
      copy({ headline: 'Artisan sourdough starter' }),
      evidence({ restrictions: ['artisan'] }),
    );

    expect(result.violations[0]?.rule).toBe('merchant-restriction');
    expect(result.violations[0]?.detail).toMatch(/you asked us not to/i);
  });
});

describe('reporting', () => {
  it('reports every problem, not just the first', () => {
    // A reviewer fixing one issue at a time, re-running, and finding another
    // is a worse experience than seeing all three at once.
    const result = checkClaims(
      copy({ primaryText: 'The best! 60% off! Only 2 left!' }),
      evidence(),
    );

    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('quotes the offending fragment so it can be found', () => {
    const result = checkClaims(copy({ headline: 'Unbeatable value' }), evidence());
    expect(result.violations[0]?.excerpt).toBe('Unbeatable');
  });
});

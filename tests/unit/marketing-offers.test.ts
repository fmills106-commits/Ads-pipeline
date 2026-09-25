import { describe, expect, it } from 'vitest';
import { DEFAULT_OFFER_RULES, proposeForProduct } from '@/server/marketing/offers';

/**
 * These rules decide what a merchant's customers are charged, so the tests are
 * about the money: that a margin is never invented, that a ceiling is never
 * exceeded, and that a product nobody can buy is never discounted.
 */

const rules = (overrides = {}) => ({ ...DEFAULT_OFFER_RULES, ...overrides });

const product = (overrides = {}) => ({
  id: 'p1',
  name: 'Gooseneck kettle',
  priceCents: 6400,
  costCents: null as number | null,
  comparePriceCents: null as number | null,
  currency: 'USD',
  availability: 'IN_STOCK' as const,
  ...overrides,
});

describe('margin', () => {
  it('is reported as unknown when the merchant never supplied a cost', () => {
    // The rule this exists for: the scanner may not infer a cost, so absence
    // is genuine, and an estimate here would be a number someone discounts
    // against.
    const result = proposeForProduct(product(), rules());

    expect('reason' in result).toBe(false);
    if ('reason' in result) return;
    expect(result.marginKnown).toBe(false);
    expect(result.estimatedMarginCents).toBeNull();
    expect(result.rationale).toMatch(/do not know what this costs you/i);
  });

  it('is calculated when the merchant did supply one', () => {
    const result = proposeForProduct(product({ costCents: 3000 }), rules());

    if ('reason' in result) throw new Error(result.reason);
    expect(result.marginKnown).toBe(true);
    // 5% off 64.00 → 60.80, less 30.00 cost.
    expect(result.resultingPriceCents).toBe(6080);
    expect(result.estimatedMarginCents).toBe(3080);
  });

  it('refuses an offer that would sell at a loss', () => {
    const result = proposeForProduct(product({ costCents: 6300 }), rules());
    expect(result).toEqual({ reason: 'the discount would sell it at a loss' });
  });

  it('respects a minimum margin the merchant set', () => {
    const result = proposeForProduct(product({ costCents: 5500 }), rules({ minMarginPercent: 40 }));
    expect('reason' in result && result.reason).toMatch(/40% minimum margin/);
  });

  it('cannot breach a minimum margin it has no cost to check against', () => {
    // No cost means the margin rule is unenforceable, which must not silently
    // become "allowed with an assumed margin".
    const result = proposeForProduct(product(), rules({ minMarginPercent: 90 }));

    if ('reason' in result) throw new Error(result.reason);
    expect(result.marginKnown).toBe(false);
  });
});

describe('the discount ceiling', () => {
  it('proposes the smallest discount allowed, not the largest', () => {
    const result = proposeForProduct(
      product(),
      rules({ minDiscountPercent: 5, maxDiscountPercent: 50 }),
    );

    if ('reason' in result) throw new Error(result.reason);
    expect(result.value).toBe(5);
  });

  it('refuses when the settings leave no room', () => {
    const result = proposeForProduct(
      product(),
      rules({ minDiscountPercent: 30, maxDiscountPercent: 20 }),
    );
    expect('reason' in result).toBe(true);
  });

  it('rounds the discount down so the ceiling is never crossed', () => {
    // 7% of 333 is 23.31; rounding up would discount more than permitted.
    const result = proposeForProduct(
      product({ priceCents: 333 }),
      rules({ minDiscountPercent: 7 }),
    );

    if ('reason' in result) throw new Error(result.reason);
    expect(result.resultingPriceCents).toBe(333 - 23);
  });
});

describe('products that must not be discounted', () => {
  it('skips one that is out of stock', () => {
    // Advertising something nobody can buy is the failure the spec names.
    const result = proposeForProduct(product({ availability: 'OUT_OF_STOCK' }), rules());
    expect(result).toEqual({ reason: 'it is out of stock' });
  });

  it('skips one already on sale', () => {
    // Stacking a second reduction produces a price the merchant never agreed
    // to, in front of shoppers who saw both numbers.
    const result = proposeForProduct(
      product({ priceCents: 4800, comparePriceCents: 6400 }),
      rules(),
    );
    expect(result).toEqual({ reason: 'it is already on sale' });
  });

  it('skips one whose page states no price', () => {
    const result = proposeForProduct(
      product({ priceCents: null }),
      rules({ allowFreeShipping: false }),
    );
    expect(result).toEqual({ reason: 'its page states no price' });
  });

  it('refuses a discount that would reach zero', () => {
    const result = proposeForProduct(
      product({ priceCents: 100 }),
      rules({ minDiscountPercent: 100, maxDiscountPercent: 100 }),
    );
    expect('reason' in result).toBe(true);
  });
});

describe('a product with no stated price', () => {
  it('is offered free shipping, which does not depend on the price', () => {
    const result = proposeForProduct(product({ priceCents: null }), rules());

    if ('reason' in result) throw new Error(result.reason);
    expect(result.type).toBe('FREE_SHIPPING');
    expect(result.resultingPriceCents).toBeNull();
    expect(result.value).toBeNull();
  });
});

describe('the defaults', () => {
  it('require a person to approve anything', () => {
    // A business that never opens the settings screen must not be able to
    // have a discount published on its behalf.
    expect(DEFAULT_OFFER_RULES.requireApproval).toBe(true);
    expect(DEFAULT_OFFER_RULES.allowAutomatic).toBe(false);
  });

  it('cap discounts modestly', () => {
    expect(DEFAULT_OFFER_RULES.maxDiscountPercent).toBeLessThanOrEqual(25);
  });
});

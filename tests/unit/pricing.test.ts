import { describe, expect, it } from 'vitest';
import {
  approximateTokens,
  costOf,
  DEAREST_KNOWN_PRICE,
  estimateCallCostCents,
  priceFor,
  toWholeCents,
} from '@/server/providers/pricing';

/**
 * Turning tokens into money.
 *
 * Tested on its own because both halves of the cost guarantee run through here:
 * the estimate a spending limit is checked against before a call, and the figure
 * written to the ledger afterwards. An error in the first direction lets a call
 * through that a limit should have stopped; an error in the second understates a
 * bill. Both are tested for their direction, not just their arithmetic.
 */

describe('model prices', () => {
  it('knows the models this build was checked against', () => {
    expect(priceFor('claude-sonnet-5')).toEqual({
      inputCentsPerMTok: 200,
      outputCentsPerMTok: 1_000,
    });
  });

  it('bills a dated snapshot as its family', () => {
    expect(priceFor('claude-sonnet-5-20260101')).toEqual(priceFor('claude-sonnet-5'));
  });

  it('admits when it does not know a price', () => {
    // Not a plausible-looking number. The nullability of `actualCostCents`
    // exists for exactly this case.
    expect(priceFor('claude-something-unreleased')).toBeNull();
  });

  it('knows which of its prices is dearest', () => {
    expect(DEAREST_KNOWN_PRICE.inputCentsPerMTok).toBe(500);
    expect(DEAREST_KNOWN_PRICE.outputCentsPerMTok).toBe(2_500);
  });
});

describe('what a call cost', () => {
  const sonnet = { inputCentsPerMTok: 200, outputCentsPerMTok: 1_000 };

  it('prices input and output at their separate rates', () => {
    expect(costOf(sonnet, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(1_200);
  });

  it('rounds to the nearest cent', () => {
    expect(toWholeCents(1.4)).toBe(1);
    expect(toWholeCents(1.6)).toBe(2);
  });

  it('never records real spending as nothing', () => {
    // The one direction this must not round: a month of sub-cent calls showing
    // as $0.00 would make real spending invisible.
    expect(toWholeCents(0.02)).toBe(1);
    expect(toWholeCents(0)).toBe(0);
  });
});

describe('what a call might cost', () => {
  it('assumes the whole output allowance is spent', () => {
    const generous = estimateCallCostCents({
      model: 'claude-sonnet-5',
      promptChars: 100,
      maxOutputTokens: 4_000,
    });
    const frugal = estimateCallCostCents({
      model: 'claude-sonnet-5',
      promptChars: 100,
      maxOutputTokens: 100,
    });

    expect(generous).toBeGreaterThan(frugal);
  });

  it('prices an unknown model at the dearest rate it knows', () => {
    const unknown = estimateCallCostCents({
      model: 'claude-something-unreleased',
      promptChars: 400_000,
      maxOutputTokens: 4_000,
    });
    const dearest = estimateCallCostCents({
      model: 'claude-opus-5',
      promptChars: 400_000,
      maxOutputTokens: 4_000,
    });

    expect(unknown).toBe(dearest);
  });

  it('never estimates a paid call at nothing', () => {
    /*
     * `checkBudget` reads an estimate of zero as "free" and skips every ceiling,
     * so a paid call estimated at zero would spend with no limit in force. The
     * floor of one cent is what makes that unreachable.
     */
    expect(
      estimateCallCostCents({ model: 'claude-sonnet-5', promptChars: 0, maxOutputTokens: 0 }),
    ).toBeGreaterThan(0);
  });

  it('counts tokens on the high side, prompts being worse than prose', () => {
    // Four characters to a token is the rule of thumb for English; these
    // prompts carry URLs and prices, which tokenise worse.
    expect(approximateTokens('a'.repeat(400))).toBeGreaterThan(100);
  });
});

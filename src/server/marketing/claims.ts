import { formatCents } from '@/lib/budget';

/**
 * The last thing between generated copy and a merchant's customers.
 *
 * Schema validation proves an ad is *shaped* like an ad. This asks the harder
 * question: is everything it asserts something the merchant's own website
 * actually says? A headline reading "Now 40% off — award-winning, 10,000 happy
 * customers" passes every schema and is three separate lies.
 *
 * The check is deliberately **allow-listed against evidence** rather than
 * pattern-matched for bad words. A blocklist of forbidden phrases is endless
 * and trivially evaded by rephrasing; asking "this copy mentions a price —
 * does that price appear in the verified facts?" cannot be rephrased around,
 * because the problem is the claim, not the wording.
 *
 * What it cannot do: judge whether a subjective statement is fair. "Beautifully
 * made" is not checkable and is not this function's business. It checks the
 * things that are *falsifiable* — prices, discounts, superlatives, statistics,
 * guarantees, urgency — because those are the ones that get a merchant into
 * trouble with a customer or a regulator.
 */

export interface CopyUnderTest {
  primaryText: string;
  headline: string;
  description: string;
  cta: string;
}

/** What the merchant's own site supports, gathered by the caller. */
export interface ClaimEvidence {
  /** Prices stated on the product page, in minor units. */
  statedPriceCents: number[];
  currency: string;
  /** Discount percentages the page itself advertises, plus any approved offer. */
  allowedDiscountPercents: number[];
  /** Text the merchant published, for phrase-level corroboration. */
  verifiedText: string;
  /** Claims this merchant has said they do not want made. */
  restrictions: string[];
  /** True when an approved, unexpired offer backs a discount claim. */
  hasActiveOffer: boolean;
}

export interface ClaimViolation {
  rule: string;
  detail: string;
  /** The offending fragment, so a reviewer can see it without hunting. */
  excerpt: string;
}

export interface ClaimCheck {
  ok: boolean;
  violations: ClaimViolation[];
}

/**
 * A currency amount, ending on a digit.
 *
 * The trailing `\d` matters: `[\d.,]*` alone also swallows the full stop that
 * ends a sentence, so "Just £18.00." matched "£18.00." — which parses as NaN
 * and so matched no stated price, flagging a correct price as invented.
 */
const MONEY = /[$£€¥]\s?\d(?:[\d.,]*\d)?/g;
const PERCENT_OFF = /(\d{1,3})\s*%\s*(?:off|discount)/gi;

/**
 * Superlatives and absolutes.
 *
 * Unprovable by construction: nobody can substantiate "the best" for a
 * merchant we know nothing about beyond their own site, and advertising
 * standards in most jurisdictions treat an unsubstantiated superlative as
 * misleading.
 */
const SUPERLATIVES =
  /\b(?:best|greatest|finest|#\s?1|number one|world'?s leading|unbeatable|guaranteed|perfect|miracle|revolutionary)\b/gi;

/** Any specific quantity claim: "10,000 customers", "rated 4.8", "97% of". */
const STATISTICS = /\b\d[\d,.]*\s*(?:%|customers|reviews|sold|users|stars|out of \d)/gi;

/** Manufactured scarcity and deadlines we have no way to verify. */
const URGENCY =
  /\b(?:only\s+\d+\s+left|last chance|ends (?:today|tonight|soon)|hurry|while stocks last|limited time)\b/gi;

/** Health, income and outcome promises — the categories that attract regulators. */
const PROMISES =
  /\b(?:cures?|heals?|treats?|clinically proven|doctor recommended|lose \d+|earn \$?\d+|risk[- ]free|money[- ]back)\b/gi;

export function checkClaims(copy: CopyUnderTest, evidence: ClaimEvidence): ClaimCheck {
  const violations: ClaimViolation[] = [];
  const all = `${copy.headline}\n${copy.primaryText}\n${copy.description}\n${copy.cta}`;

  // --- prices the site does not state -------------------------------------
  const allowedPrices = new Set(
    evidence.statedPriceCents.flatMap((cents) => [
      formatCents(cents, evidence.currency).replace(/\s/g, ''),
      (cents / 100).toFixed(2),
      String(Math.round(cents / 100)),
    ]),
  );

  for (const match of all.match(MONEY) ?? []) {
    const normalised = match.replace(/\s/g, '');
    const numeric = normalised.replace(/[^\d.,]/g, '').replace(/,/g, '');
    const supported =
      allowedPrices.has(normalised) ||
      allowedPrices.has(numeric) ||
      allowedPrices.has(Number(numeric).toFixed(2)) ||
      allowedPrices.has(String(Math.round(Number(numeric))));

    if (!supported) {
      violations.push({
        rule: 'unstated-price',
        detail:
          'This price does not appear on the product page. Advertising a price the site does not show is how a customer arrives to a different number.',
        excerpt: match,
      });
    }
  }

  // --- discounts with nothing behind them ---------------------------------
  for (const match of all.matchAll(PERCENT_OFF)) {
    const percent = Number(match[1]);
    const supported = evidence.allowedDiscountPercents.includes(percent);

    if (!supported) {
      violations.push({
        rule: 'unsupported-discount',
        detail: evidence.hasActiveOffer
          ? 'This discount does not match the approved offer.'
          : 'There is no approved offer or stated sale backing this discount.',
        excerpt: match[0],
      });
    }
  }

  // --- unprovable assertions ----------------------------------------------
  const patterns: Array<[RegExp, string, string]> = [
    [
      SUPERLATIVES,
      'unsubstantiated-superlative',
      'Nothing on the site substantiates this, and an unprovable superlative is treated as misleading in most advertising codes.',
    ],
    [
      STATISTICS,
      'unverifiable-statistic',
      'A specific figure needs a source. None of the verified facts contain this one.',
    ],
    [
      URGENCY,
      'manufactured-urgency',
      'We have no stock counts or end dates from the site, so this deadline would be invented.',
    ],
    [
      PROMISES,
      'regulated-promise',
      'Health, income and guarantee claims need evidence this system does not have.',
    ],
  ];

  for (const [pattern, rule, detail] of patterns) {
    for (const match of all.match(pattern) ?? []) {
      // A phrase the merchant themselves published is theirs to make.
      if (evidence.verifiedText.toLowerCase().includes(match.toLowerCase())) continue;
      violations.push({ rule, detail, excerpt: match });
    }
  }

  // --- the merchant's own bans --------------------------------------------
  for (const restriction of evidence.restrictions) {
    const needle = restriction.trim().toLowerCase();
    if (needle !== '' && all.toLowerCase().includes(needle)) {
      violations.push({
        rule: 'merchant-restriction',
        detail: 'You asked us not to use this.',
        excerpt: restriction,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}

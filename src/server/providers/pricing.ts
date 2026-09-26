/**
 * What a paid model call costs.
 *
 * Kept apart from the adapter that calls the model, for two reasons that both
 * come down to the same thing — money must be knowable before it is spent:
 *
 *  1. The **estimate** is needed before a provider is even selected, because
 *    `checkBudget` runs before the call and treats an estimate of zero as
 *    "free" and skips every ceiling. An AI call that reached a paid provider
 *    with no estimate would therefore spend without a limit. So the marketing
 *    engine prices its own prompt up front, and it must be able to do that
 *    without importing an adapter or knowing which one will run.
 *  2. The **actual** cost is reported by the model afterwards in tokens, not
 *    money, and turning tokens into cents needs a table. A table is a fact
 *    about the world that goes stale, so it says plainly which models it knows
 *    and refuses to guess about the rest.
 *
 * Only published rates that were checked appear here. An unrecognised model is
 * not priced at a plausible-looking number: it is estimated at the dearest rate
 * known (so the ceiling stays protective) and its actual cost is recorded as
 * unknown rather than as a guess, which is what `ProviderUsage.actualCostCents`
 * being nullable is for.
 */

export interface ModelPrice {
  /** Cents per million input tokens. */
  inputCentsPerMTok: number;
  /** Cents per million output tokens. Reasoning tokens bill as output. */
  outputCentsPerMTok: number;
}

/**
 * Published list prices, in cents per million tokens.
 *
 * Checked September 2026. A model absent from here still works — it is priced
 * conservatively for the ceiling check and reported as unknown afterwards.
 */
const PRICES: Record<string, ModelPrice> = {
  'claude-opus-5': { inputCentsPerMTok: 500, outputCentsPerMTok: 2_500 },
  'claude-sonnet-5': { inputCentsPerMTok: 200, outputCentsPerMTok: 1_000 },
  'claude-haiku-4-5': { inputCentsPerMTok: 100, outputCentsPerMTok: 500 },
};

/** Reading from the prompt cache bills at a tenth of the input rate. */
const CACHE_READ_MULTIPLIER = 0.1;
/** Writing to it costs a quarter more than the plain input rate. */
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Roughly four characters to a token in English, and prompts here are not
 * plain English — they carry URLs, prices and markup fragments, which tokenise
 * worse. Three and a half keeps the estimate on the high side, which is the
 * safe side for something a spending limit is checked against.
 */
const CHARS_PER_TOKEN = 3.5;

/** The rate for a model, or null when this build has no checked price for it. */
export function priceFor(model: string): ModelPrice | null {
  const exact = PRICES[model];
  if (exact) return exact;

  // A dated snapshot such as `claude-sonnet-5-20260101` bills as its family.
  for (const [family, price] of Object.entries(PRICES)) {
    if (model.startsWith(`${family}-`)) return price;
  }

  return null;
}

/** The dearest rate known, used to price a model this build has never heard of. */
export const DEAREST_KNOWN_PRICE: ModelPrice = Object.values(PRICES).reduce(
  (dearest, price) => ({
    inputCentsPerMTok: Math.max(dearest.inputCentsPerMTok, price.inputCentsPerMTok),
    outputCentsPerMTok: Math.max(dearest.outputCentsPerMTok, price.outputCentsPerMTok),
  }),
  { inputCentsPerMTok: 0, outputCentsPerMTok: 0 },
);

export function approximateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Output allowance assumed when a caller names none.
 *
 * Lives here, with the pricing, because the estimate and the call have to agree
 * about it: the marketing engine prices the allowance before a provider is
 * chosen, and the adapter then has to ask for that same allowance or the figure
 * the ceiling was checked against described a different call.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the prompt cache, billed at a tenth. */
  cacheReadTokens?: number;
  /** Tokens written to the prompt cache, billed at a quarter more. */
  cacheWriteTokens?: number;
}

/** Exact cost in cents, fractions included. */
export function costOf(price: ModelPrice, usage: TokenUsage): number {
  const perInputToken = price.inputCentsPerMTok / 1_000_000;
  const perOutputToken = price.outputCentsPerMTok / 1_000_000;

  return (
    usage.inputTokens * perInputToken +
    usage.outputTokens * perOutputToken +
    (usage.cacheReadTokens ?? 0) * perInputToken * CACHE_READ_MULTIPLIER +
    (usage.cacheWriteTokens ?? 0) * perInputToken * CACHE_WRITE_MULTIPLIER
  );
}

/**
 * Cents as the ledger stores them: a whole number.
 *
 * Rounds to the nearest cent, except that anything that cost *something* is
 * recorded as at least one. A call that cost two tenths of a cent showing as
 * $0.00 would make a month of real spending look free, which is the one
 * direction this must never round.
 */
export function toWholeCents(cents: number): number {
  if (cents <= 0) return 0;
  return Math.max(1, Math.round(cents));
}

/**
 * What one photograph costs to look at, in input tokens.
 *
 * An image bills as roughly its pixels divided by 750, so this stands for an
 * image about 1100 pixels square — a large product photograph. Smaller ones cost
 * less and this over-states them, which is the right direction for a number a
 * spending limit is checked against.
 *
 * Worth knowing in cents: at the default model, about a third of a penny each.
 * Three of them add roughly a penny to a call — real, and small against what
 * they add, which is a writer that has seen the product.
 */
export const TOKENS_PER_IMAGE = 1_600;

export interface EstimateInput {
  model: string;
  /** Everything that will be sent: instruction, data blocks, system prompt. */
  promptChars: number;
  /** The output ceiling for the call. Assumed spent in full. */
  maxOutputTokens: number;
  /** Photographs sent with it, which bill as input tokens. */
  imageCount?: number;
}

/**
 * What one call could cost at worst, for the ceiling check.
 *
 * Deliberately pessimistic: the whole output allowance is assumed used, an
 * unknown model is priced at the dearest known rate, and the result is rounded
 * up. Under-estimating here would let a call through that the owner's limit was
 * meant to stop, and the cost of over-estimating is only that a limit bites one
 * call sooner.
 */
export function estimateCallCostCents(input: EstimateInput): number {
  const price = priceFor(input.model) ?? DEAREST_KNOWN_PRICE;
  const cents = costOf(price, {
    inputTokens:
      Math.ceil(input.promptChars / CHARS_PER_TOKEN) + (input.imageCount ?? 0) * TOKENS_PER_IMAGE,
    outputTokens: input.maxOutputTokens,
  });

  return Math.max(1, Math.ceil(cents));
}

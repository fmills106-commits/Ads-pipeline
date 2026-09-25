import { z } from 'zod';

/**
 * The shapes the marketing engine will accept from a model.
 *
 * These are the enforcement point for §"all AI output validated against a
 * schema": a response that does not match is retried once and then refused,
 * so nothing unvalidated reaches the database. They are deliberately strict
 * about *shape* and quiet about *content* — a schema can insist that a
 * headline is a string of reasonable length, but it cannot tell whether the
 * claim in it is true. That job belongs to the claim checker, which runs
 * against verified facts rather than against a regex.
 *
 * Two recurring decisions:
 *
 *  - `simulated` is required everywhere. The free provider sets it, and the
 *    flag travels with the data so a screen can say "this is a placeholder"
 *    rather than presenting a stub as a recommendation.
 *  - Uncertainty is a word, never a number. `0.82` would look like a
 *    measurement of something nobody measured.
 */

export const uncertaintyLevel = z.enum(['low', 'medium', 'high']);
export type UncertaintyLevel = z.infer<typeof uncertaintyLevel>;

/** Bounded so one runaway response cannot fill a column or a page. */
const shortText = z.string().trim().min(1).max(300);
const mediumText = z.string().trim().min(1).max(1_000);
const claimList = z.array(z.string().trim().min(1).max(300)).max(10);

export const strategyAngle = z.enum([
  'PROBLEM_SOLUTION',
  'BENEFIT',
  'DEMONSTRATION',
  'LIFESTYLE',
  'SEASONAL',
  'GIFT',
  'VALUE',
  'SOCIAL_PROOF',
  'URGENCY',
  'EDUCATIONAL',
  'COMPARISON',
]);

export const inferenceKind = z.enum([
  'AUDIENCE_HYPOTHESIS',
  'MOTIVATION',
  'OBJECTION',
  'USE_CASE',
  'SEASONAL_OPPORTUNITY',
]);

/**
 * A conclusion, with its reasoning and its doubt attached.
 *
 * `reasoning` is required, not optional. An audience hypothesis with no stated
 * reasoning is indistinguishable from a guess, and the owner deserves to see
 * which one they are looking at.
 */
export const hypothesisSchema = z.object({
  statement: shortText,
  reasoning: mediumText,
  uncertainty: uncertaintyLevel.default('high'),
  kind: inferenceKind.default('AUDIENCE_HYPOTHESIS'),
});

export const businessAnalysisSchema = z.object({
  simulated: z.boolean().default(false),
  valueProposition: mediumText,
  brandVoice: shortText,
  /**
   * Words and claims this merchant should not make. Read off their own site
   * where it says so, otherwise empty — the engine does not invent rules on a
   * merchant's behalf.
   */
  restrictions: claimList.default([]),
  audienceHypotheses: z.array(hypothesisSchema).min(1).max(8),
});
export type BusinessAnalysis = z.infer<typeof businessAnalysisSchema>;

export const strategySchema = z.object({
  angle: strategyAngle,
  hypothesis: mediumText,
  hook: shortText,
  suggestedCta: z.string().trim().min(1).max(40),
  /** What must be true for this to work, so it can be checked rather than believed. */
  assumptions: claimList.default([]),
  /** What an experiment should vary. Phase 8 consumes these directly. */
  testingVariables: claimList.default([]),
});

export const strategySetSchema = z.object({
  simulated: z.boolean().default(false),
  strategies: z.array(strategySchema).min(1).max(6),
});
export type StrategySet = z.infer<typeof strategySetSchema>;

/**
 * Ad copy, sized to what an ad platform will actually accept.
 *
 * The limits are not arbitrary: copy that overruns is rejected at publish
 * time, which is a worse place to discover it than here.
 */
export const adCopyVariantSchema = z.object({
  primaryText: z.string().trim().min(1).max(500),
  headline: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1).max(120),
  cta: z.string().trim().min(1).max(40),
});

export const adCopySetSchema = z.object({
  simulated: z.boolean().default(false),
  variants: z.array(adCopyVariantSchema).min(1).max(5),
});
export type AdCopySet = z.infer<typeof adCopySetSchema>;

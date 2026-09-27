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

/**
 * What the product looks like, for whoever or whatever makes the picture.
 *
 * This exists because of a specific, instructive failure. The engine produced a
 * genuinely good reading of a shop — soft slow-rising foam, 5.5 inches, sealed
 * wrappers, twelve Halloween designs, not edible, ages 14 and over — the owner
 * pasted it into an image generator, and got back a bow-tied black cat, a
 * Frankenstein head and a haunted-house print. None of which they sell.
 *
 * Nothing had gone wrong with the writing. The failure was that ad copy has
 * nowhere to put *appearance*, so the image model filled the silence with the
 * most generic Halloween imagery available. A picture cannot be prompted out of
 * facts about shipping and materials.
 *
 * So this is a different shape for a different job, and two of its fields matter
 * more than the rest:
 *
 *  - `doNotShow` — the negative space. "No cats, no skeletons" is worth more to
 *    an image generator than any amount of positive description, because
 *    inventing plausible neighbours is exactly what it does with a gap.
 *  - `seen` — whether the description came from looking at the merchant's
 *    photographs or from reading their words. A brief written blind is a guess
 *    about appearance, and must say so rather than sounding equally confident.
 */
export const visualBriefSchema = z.object({
  simulated: z.boolean().default(false),
  /** True only when actual photographs were looked at. */
  seen: z.boolean().default(false),
  /** One sentence: what a person would say this is, on seeing it. */
  looksLike: mediumText,
  /** Colours actually present, in plain words — "matte orange", not "#F60". */
  colours: claimList.default([]),
  /** Shape and finish: what it is, physically. */
  form: shortText,
  /** How it is packaged and presented, if the pictures show it. */
  packaging: shortText.optional(),
  /** Words and marks visible on the product or its wrapper. */
  printedText: claimList.default([]),
  /** How big it is, and what gives that away. */
  scale: shortText.optional(),
  /**
   * What an image of this must not contain.
   *
   * The most valuable field here. Left empty, a generator invents; filled, it
   * has something to avoid.
   */
  doNotShow: claimList.default([]),
  /**
   * A prompt the owner can paste straight into an image tool.
   *
   * Composed from the fields above rather than written freely, so it cannot
   * contain a detail the rest of the brief does not support.
   */
  imagePrompt: z.string().trim().min(1).max(1_200),
});
export type VisualBrief = z.infer<typeof visualBriefSchema>;

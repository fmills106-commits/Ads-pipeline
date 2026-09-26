import { prisma, type Db } from '@/lib/db';
import { validationError } from '@/lib/errors';
import { recordActivity } from '@/server/activity/feed';
import { AUDIT_ACTIONS, recordAudit } from '@/server/audit/log';
import type { BusinessContext } from '@/server/tenancy/context';
import { generate } from './ai';
import { businessAnalysisSchema, type BusinessAnalysis } from './schemas';
import type { InferenceKind, Uncertainty } from '@prisma/client';
import { gatherEvidence } from './evidence';

/**
 * Turning what was read into what is thought.
 *
 * The scanner produced facts: a name, a price, an email, each with the URL it
 * came from. This turns those into a reading of the business — what it seems
 * to offer, how it sounds, who might want it — and is careful about the
 * difference the whole time.
 *
 * Two rules do most of the work here:
 *
 *  - **Nothing is analysed that was not first verified.** The model is given
 *    facts and page text, not a business name to free-associate from. A
 *    business with no completed scan is refused rather than guessed at.
 *  - **Conclusions go in `ai_inferences`, never `business_facts`.** The two
 *    tables are written by different functions in different modules, and
 *    there is no operation anywhere that moves a row from one to the other.
 *    That is what makes "we never present a guess as a fact" a property of
 *    the system rather than a promise about how carefully people will code.
 */

export interface AnalyseResult {
  profileId: string;
  decisionId: string;
  inferencesCreated: number;
  simulated: boolean;
  /** Ids of the verified facts the reading was built from. */
  factIds: string[];
}

/** How much verified material is worth reasoning over at all. */
const MIN_FACTS_TO_ANALYSE = 3;

/** Bounds on what is handed to a model, per field. */

export async function analyseBusiness(
  context: BusinessContext,
  db: Db = prisma,
): Promise<AnalyseResult> {
  const evidence = await gatherEvidence(context, {}, db);

  /*
   * Refusing is the right answer here, not proceeding with less. An analysis
   * built on two facts would look exactly like one built on sixty, and the
   * owner would have no way to tell. Asking them to scan first is honest and
   * takes one click.
   */
  if (evidence.factCount < MIN_FACTS_TO_ANALYSE) {
    throw validationError('Not enough verified information to analyse this business', {
      publicMessage:
        'We need to read your website first. Open the Website page and press “Read my website”.',
      details: { factsFound: evidence.factCount, required: MIN_FACTS_TO_ANALYSE },
    });
  }

  const result = await generate({
    context,
    task: 'business.analyse',
    instruction: [
      'You are helping a small business advertise what it already sells.',
      'Using only the material supplied, describe what this business offers,',
      'how it sounds, and who might plausibly want it.',
      'The image descriptions are the merchant\u2019s own words about their own',
      'pictures, and are often the most specific thing available: use them for',
      'what the products look like and what they are called.',
      'Do not state a price, a statistic, an award, or a claim that does not',
      'appear in the supplied material. Where you are inferring rather than',
      'reading, say so in the reasoning and set the uncertainty honestly.',
    ].join(' '),
    data: {
      businessName: evidence.businessName,
      ownerNotes: evidence.ownerNotesText,
      verifiedFacts: evidence.factsText,
      products: evidence.productsText,
      pageText: evidence.pageText,
      imageDescriptions: evidence.imageText,
    },
    schema: businessAnalysisSchema,
    inputSummary: `${evidence.factCount} verified facts and ${evidence.productCount} products from ${evidence.businessName}`,
    factIds: evidence.factIds,
    db,
  });

  const { profileId, inferencesCreated } = await persistAnalysis(
    context,
    result.value,
    result.decisionId,
    evidence.factIds,
    db,
  );

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      businessId: context.businessId,
      actorType: 'AI',
      action: AUDIT_ACTIONS.businessAnalysed,
      objectType: 'BusinessProfile',
      objectId: profileId,
      newValue: {
        decisionId: result.decisionId,
        providerKey: result.providerKey,
        simulated: result.simulated,
        inferences: inferencesCreated,
      },
    },
    db,
  );

  await recordActivity(
    context,
    {
      kind: 'analysisReady',
      message: simulatedMessage(result.simulated, inferencesCreated),
      detail: { decisionId: result.decisionId, inferences: inferencesCreated },
    },
    db,
  );

  return {
    profileId,
    decisionId: result.decisionId,
    inferencesCreated,
    simulated: result.simulated,
    factIds: evidence.factIds,
  };
}

/**
 * The owner-facing line.
 *
 * A simulated reading says so in the first clause. Burying that at the bottom
 * of a settings page, or omitting it because it reads better, is exactly the
 * kind of small dishonesty that makes the rest untrustworthy.
 */
function simulatedMessage(simulated: boolean, inferences: number): string {
  const count = `${inferences} ${inferences === 1 ? 'idea' : 'ideas'} about who might buy`;
  return simulated
    ? `Put together a first reading of your business and ${count}. This used the free built-in generator, so treat it as a starting point.`
    : `Read your website and worked out what you sell, plus ${count}.`;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Collects what has actually been verified about this business.
 *
 * Everything returned is scoped to the context's business — the model is never
 * shown another tenant's material, which is not merely a privacy matter: a
 * strategy built from someone else's catalogue would be wrong as well as
 * improper.
 */
// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const UNCERTAINTY_BY_WORD: Record<string, Uncertainty> = {
  low: 'LOW',
  medium: 'MEDIUM',
  high: 'HIGH',
};

/**
 * Writes the profile and the inferences, replacing the previous reading.
 *
 * Replacement rather than accumulation: two contradictory readings of the same
 * business, both current, would be worse than one that is merely out of date.
 * The `ai_decisions` row for each remains, so the history is not lost — it is
 * simply not presented as current thinking.
 */
async function persistAnalysis(
  context: BusinessContext,
  analysis: BusinessAnalysis,
  decisionId: string,
  factIds: string[],
  db: Db,
): Promise<{ profileId: string; inferencesCreated: number }> {
  const profile = await db.businessProfile.upsert({
    where: { businessId: context.businessId },
    create: {
      businessId: context.businessId,
      valueProposition: analysis.valueProposition,
      brandVoice: analysis.brandVoice,
      restrictions: analysis.restrictions,
      aiDecisionId: decisionId,
    },
    update: {
      valueProposition: analysis.valueProposition,
      brandVoice: analysis.brandVoice,
      restrictions: analysis.restrictions,
      aiDecisionId: decisionId,
      generatedAt: new Date(),
    },
    select: { id: true },
  });

  // Only the hypotheses from previous readings go; anything Phase 8 later
  // learns from a real experiment will be written by a different path.
  await db.aiInference.deleteMany({
    where: { businessId: context.businessId, subjectType: null },
  });

  const created = await db.aiInference.createMany({
    data: analysis.audienceHypotheses.map((hypothesis) => ({
      businessId: context.businessId,
      kind: hypothesis.kind as InferenceKind,
      statement: hypothesis.statement,
      reasoning: hypothesis.reasoning,
      uncertainty: UNCERTAINTY_BY_WORD[hypothesis.uncertainty] ?? 'HIGH',
      supportingFactIds: factIds,
      aiDecisionId: decisionId,
    })),
  });

  return { profileId: profile.id, inferencesCreated: created.count };
}

/** The current reading, for the UI. Null when nothing has been analysed yet. */
export async function getAnalysis(context: BusinessContext, db: Db = prisma) {
  const [profile, inferences, decision] = await Promise.all([
    db.businessProfile.findUnique({ where: { businessId: context.businessId } }),
    db.aiInference.findMany({
      where: { businessId: context.businessId },
      orderBy: [{ uncertainty: 'asc' }, { createdAt: 'desc' }],
      take: 20,
    }),
    db.aiDecision.findFirst({
      where: { businessId: context.businessId, kind: 'business.analyse' },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return { profile, inferences, decision };
}

import type { ZodTypeAny, z } from 'zod';
import { ZodError } from 'zod';
import { prisma, type Db } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { loadPaidProviderState, runProvider } from '@/server/providers';
import { jsonSchemaOf } from '@/server/providers/output-schema';
import { DEFAULT_MAX_OUTPUT_TOKENS, estimateCallCostCents } from '@/server/providers/pricing';
import type { AIProvider, ProvidedImage } from '@/server/providers/types';
import type { BusinessContext } from '@/server/tenancy/context';
import {
  sanitiseExtractedText,
  scanForInjectionSignals,
  truncateForPrompt,
} from '@/server/scanner/untrusted';

/**
 * The one way the marketing engine talks to a model.
 *
 * Every AI call in the application goes through here, which is what makes the
 * guarantees around it enforceable rather than a convention each caller has to
 * remember:
 *
 *  1. **Untrusted content is data.** Scraped page text never reaches the
 *     `instruction` field. It is wrapped in per-call random delimiters and
 *     passed as `data`, a separate parameter, with a preamble stating that
 *     what follows is third-party material and not an instruction.
 *  2. **Output is validated, always.** The caller supplies a Zod schema and
 *     gets back a parsed value or an exception. There is no path by which
 *     unvalidated model output reaches the database — the local provider is
 *     held to this too, so a drift in the free implementation fails here
 *     rather than downstream.
 *  3. **One retry, then fail.** A malformed response is retried once with the
 *     validation error fed back. If the second attempt is also malformed the
 *     call fails loudly. "Repair forever" would turn a broken provider into an
 *     unbounded bill.
 *  4. **Every durable result is recorded.** An `ai_decisions` row captures
 *     what went in, what came out, which provider produced it, whether it was
 *     simulated, and which verified facts it was reasoned from — so months
 *     later "why does my ad say that?" has an answer.
 */

export interface GenerateOptions<TSchema extends ZodTypeAny> {
  context: BusinessContext;
  /** Task key the provider dispatches on, e.g. `business.analyse`. */
  task: string;
  /** Application instruction. Trusted, written by us, never interpolated with scraped text. */
  instruction: string;
  /** Untrusted third-party content, keyed by a label the model can refer to. */
  data?: Record<string, string>;
  schema: TSchema;
  /**
   * Photographs of the one thing this is about.
   *
   * Only a provider that can see uses them; the free one ignores them entirely,
   * which is why passing them changes nothing until a paid writer is switched on.
   */
  images?: ProvidedImage[];
  /** One line describing the input, for the decision record. */
  inputSummary: string;
  /** Verified fact ids this reasoning is built from. */
  factIds?: string[];
  maxOutputTokens?: number;
  db?: Db;
}

export interface GenerateResult<T> {
  value: T;
  decisionId: string;
  providerKey: string;
  /** True when no real model ran — surfaced to the owner, never hidden. */
  simulated: boolean;
}

/**
 * Runs one AI task and records the decision.
 *
 * Returns the parsed value alongside the decision id, which callers attach to
 * whatever they persist so every generated artefact is traceable to the call
 * that produced it.
 */
export async function generate<TSchema extends ZodTypeAny>(
  options: GenerateOptions<TSchema>,
): Promise<GenerateResult<z.infer<TSchema>>> {
  const db = options.db ?? prisma;
  const { context, task, schema } = options;
  const log = logger().child({ component: 'marketing-ai', task, businessId: context.businessId });

  const prepared = prepareUntrusted(options.data);
  if (prepared.signals.length > 0) {
    // Recorded, not acted on. The structural containment above is the actual
    // defence; this exists so a human can see it happened, and so a page that
    // tries it can be pointed at later.
    log.warn('Untrusted input resembles an instruction', { signals: prepared.signals });
  }

  /*
   * Both halves, from one query. The credentials matter as much as the switch:
   * without them a key the owner pasted into Settings would be invisible here,
   * and every write would quietly run on the free provider while the screen said
   * the paid one was on.
   */
  const { enabledPaid, secrets } = await loadPaidProviderState(context.workspace.id);
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  /** One attempt, through the provider guard so the call is priced and logged. */
  const callOnce = (instruction: string, label: string) =>
    runProvider<AIProvider, z.infer<TSchema>>({
      capability: 'AI',
      kind: 'AI_CALL',
      workspaceId: context.workspace.id,
      businessId: context.businessId,
      enabledPaid,
      secrets,
      subjectType: 'AiDecision',
      subjectId: label,
      /*
       * Priced before the provider is even chosen, because the ceiling is
       * checked before the call and an estimate of zero is read as "free" and
       * skips every limit. That was harmless while no paid AI adapter existed
       * and would have been a hole the moment one did: a real model would have
       * spent with no ceiling in force. Inert on the free path, which is never
       * budget-checked at all.
       */
      estimatedCostCents: estimateCallCostCents({
        model: getEnv().ANTHROPIC_MODEL,
        promptChars: promptLengthOf(instruction, prepared.data),
        maxOutputTokens,
        // Pictures bill as input tokens, so a ceiling checked without them
        // would be checking a different call from the one about to be made.
        imageCount: options.images?.length ?? 0,
      }),
      execute: (provider) =>
        provider.complete<z.infer<TSchema>>({
          task,
          instruction,
          ...(prepared.data ? { data: prepared.data } : {}),
          maxOutputTokens,
          ...(options.images?.length ? { images: options.images } : {}),
          outputSchema: jsonSchemaOf(schema),
          // Validation happens inside the provider call, so malformed output
          // never becomes a value anyone could accidentally use.
          parse: (raw) => schema.parse(raw) as z.infer<TSchema>,
        }),
    });

  let attempts = 1;
  let outcome;

  try {
    outcome = await callOnce(composeInstruction(options.instruction, prepared.preamble), task);
  } catch (thrown) {
    // Anything that is not a shape problem — a timeout, a refusal, a cost
    // ceiling — is not something rephrasing would fix.
    if (!isSchemaFailure(thrown)) throw asOutputError(thrown, task, attempts);

    const issue = describeIssues(thrown);
    log.warn('AI output failed validation; retrying once', { issue });
    attempts = 2;

    // Exactly one repair, with the specific complaint fed back. Looping until
    // the output parses would turn a confused provider into an unbounded bill.
    outcome = await callOnce(
      composeRepairInstruction(options.instruction, prepared.preamble, issue),
      `${task}:repair`,
    ).catch((second: unknown) => {
      throw asOutputError(second, task, attempts);
    });
  }

  const value = outcome.value;
  const simulated = isSimulated(value) || outcome.tier === 'LOCAL_FREE';

  const decision = await db.aiDecision.create({
    data: {
      businessId: context.businessId,
      kind: task,
      inputSummary: options.inputSummary.slice(0, 2_000),
      reasoningSummary: summariseReasoning(value, simulated),
      output: value as never,
      uncertainty: simulated ? 'high' : 'medium',
      factIds: options.factIds ?? [],
      providerKey: outcome.providerKey,
      simulated,
      estimatedCostCents: outcome.costCents,
    },
    select: { id: true },
  });

  log.info('AI task completed', {
    providerKey: outcome.providerKey,
    simulated,
    decisionId: decision.id,
    attempts,
  });

  return { value, decisionId: decision.id, providerKey: outcome.providerKey, simulated };
}

// ---------------------------------------------------------------------------
// Untrusted input
// ---------------------------------------------------------------------------

interface PreparedInput {
  data?: Record<string, string>;
  preamble: string;
  signals: string[];
}

/**
 * Cleans and bounds untrusted fields before any provider sees them.
 *
 * Note what this does *not* do: it does not wrap the values in delimiters.
 * That was the first design and it was wrong. Delimiting is a property of a
 * *prompt* — it exists so concatenated text cannot escape into instruction
 * context — and a provider that builds no prompt has nothing to escape from.
 * The local provider composes its output from these values directly, so
 * wrapping here put `<<<UNTRUSTED_… >>>` markers into the ad copy shown to
 * the owner.
 *
 * So the responsibility sits with whoever assembles a prompt: a provider that
 * does must use `wrapUntrusted` and `untrustedPreamble` from
 * `server/scanner/untrusted.ts`, which is what `buildContainedPrompt` below
 * exists to make easy and hard to forget. What is genuinely provider-agnostic
 * — stripping control characters, bidi overrides and zero-width marks, and
 * bounding length — happens here, for everyone.
 */
function prepareUntrusted(raw: Record<string, string> | undefined): PreparedInput {
  if (!raw || Object.keys(raw).length === 0) {
    return { preamble: '', signals: [] };
  }

  const data: Record<string, string> = {};
  const signals = new Set<string>();

  for (const [label, content] of Object.entries(raw)) {
    data[label] = truncateForPrompt(sanitiseExtractedText(content));
    for (const signal of scanForInjectionSignals(content).signals) signals.add(signal);
  }

  return { data, preamble: '', signals: [...signals] };
}

/**
 * Prompt assembly moved to the provider layer, where the providers that build
 * prompts live. Re-exported here because this is where the containment rules
 * are documented and where readers of this module will look for it.
 */
export { buildContainedPrompt } from '@/server/providers/prompt';

/** Roughly how long the prompt will be, for pricing it before it is built. */
function promptLengthOf(instruction: string, data: Record<string, string> | undefined): number {
  const dataChars = data
    ? Object.entries(data).reduce((total, [label, value]) => total + label.length + value.length, 0)
    : 0;

  // The wrapper around each field adds delimiters and a preamble; a fifth on
  // top covers those without pretending to a precision this does not have.
  return Math.ceil((instruction.length + dataChars) * 1.2);
}

/** The trusted instruction, with the standing warning about the data blocks. */
function composeInstruction(instruction: string, preamble: string): string {
  return preamble === '' ? instruction : `${instruction}\n\n${preamble}`;
}

function composeRepairInstruction(instruction: string, preamble: string, issue: string): string {
  return [
    composeInstruction(instruction, preamble),
    '',
    'The previous response could not be used. Return only valid output matching',
    `the required shape. The problem was: ${issue}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

function isSchemaFailure(thrown: unknown): boolean {
  if (thrown instanceof ZodError) return true;
  /*
   * A provider may find the output unusable before validation gets near it —
   * text that is not JSON at all, or a response cut off mid-sentence. That is
   * the same kind of problem as a failed parse and deserves the same single
   * rephrased retry; what must *not* land here is a refusal or a timeout, which
   * is why those carry their own codes.
   */
  if (thrown instanceof AppError && thrown.code === 'AI_OUTPUT_INVALID') return true;
  return thrown instanceof Error && thrown.cause instanceof ZodError;
}

function describeIssues(thrown: unknown): string {
  const error =
    thrown instanceof ZodError
      ? thrown
      : thrown instanceof Error && thrown.cause instanceof ZodError
        ? thrown.cause
        : null;
  if (!error) return 'the response did not match the required shape';

  return error.issues
    .slice(0, 4)
    .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
    .join('; ');
}

/**
 * Turns any failure into `AI_OUTPUT_INVALID`.
 *
 * The public message avoids blaming the owner for something a provider did,
 * and avoids echoing model output, which is untrusted.
 */
function asOutputError(thrown: unknown, task: string, attempts: number): AppError {
  if (thrown instanceof AppError && thrown.code !== 'AI_OUTPUT_INVALID') return thrown;

  return new AppError('AI_OUTPUT_INVALID', `AI task "${task}" produced unusable output`, {
    cause: thrown,
    retryable: false,
    details: { task, attempts, issue: describeIssues(thrown) },
    publicMessage: 'We could not generate that just now. Nothing has been changed.',
  });
}

// ---------------------------------------------------------------------------
// Decision records
// ---------------------------------------------------------------------------

function isSimulated(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'simulated' in value &&
    (value as { simulated?: unknown }).simulated === true
  );
}

/**
 * One line the owner could read, composed here rather than asked of the model.
 *
 * Deliberately not stored chain-of-thought: that would be unreliable as an
 * explanation and unreadable as a record. What matters downstream is whether
 * a real model ran, which is a fact we hold rather than one it reports.
 */
function summariseReasoning(value: unknown, simulated: boolean): string {
  if (simulated) {
    return 'Generated by the built-in provider without a language model. Treat as a starting point rather than a recommendation.';
  }

  if (typeof value === 'object' && value !== null && 'reasoning' in value) {
    const reasoning = (value as { reasoning?: unknown }).reasoning;
    if (typeof reasoning === 'string' && reasoning.trim() !== '') return reasoning.slice(0, 2_000);
  }

  return 'Generated from the verified facts read from this business’s own website.';
}

import { createHash } from 'node:crypto';
import { AppError } from '@/lib/errors';
import {
  FREE_USAGE,
  type AICompletionRequest,
  type AIProvider,
  type ProviderResult,
} from '../types';

/**
 * The local, free AI provider.
 *
 * It does not run a model. It produces structurally valid, deterministic
 * output for each task the marketing engine asks for, seeded from the input so
 * the same business always yields the same result — which makes the whole
 * pipeline reproducible in tests and demos.
 *
 * Two deliberate constraints keep it honest:
 *
 *  - Everything it returns is marked as simulated, and carries no invented
 *    product facts. It composes from values the caller supplied; it never
 *    asserts a price, a review, or a claim of its own.
 *  - Its output passes the same schema validation as a real provider's, so
 *    swapping in a paid provider later changes quality, not shape.
 *
 * This is what "the application must continue functioning when every paid
 * provider is disabled" means in practice.
 */

const DESCRIPTOR = {
  key: 'ai.local',
  capability: 'AI' as const,
  tier: 'LOCAL_FREE' as const,
  label: 'Built-in (free)',
  description:
    'Generates advertising strategy and copy on this machine. Costs nothing and needs no account. Output is simulated and clearly marked as such.',
  priority: 0,
  isConfigured: () => true,
};

/** Deterministic pseudo-randomness, so a given input always gives one output. */
function seededPick<T>(seed: string, options: readonly T[]): T {
  if (options.length === 0) throw new RangeError('options must not be empty');
  const hash = createHash('sha256').update(seed).digest();
  const index = hash.readUInt32BE(0) % options.length;
  return options[index]!;
}

/**
 * Task handlers. Each returns a plain object the caller's schema then
 * validates — the local provider gets no exemption from validation.
 */
const HANDLERS: Record<string, (request: AICompletionRequest<unknown>) => unknown> = {
  'business.analyse': (request) => {
    const name = request.data?.businessName ?? 'This business';
    return {
      simulated: true,
      valueProposition: `${name} sells products described on its own website.`,
      brandVoice: seededPick(name, [
        'Warm and direct',
        'Plain and practical',
        'Confident and calm',
      ]),
      // Hypotheses, never asserted as fact — the caller stores them as inferences.
      audienceHypotheses: [
        {
          statement: 'People who already searched for this kind of product',
          reasoning: 'Intent-led audiences are the usual starting point for a new account.',
          uncertainty: 'high',
        },
        {
          statement: 'Existing visitors who did not buy',
          reasoning: 'Retargeting needs no new audience research to be worth testing.',
          uncertainty: 'medium',
        },
      ],
    };
  },

  'strategy.generate': (request) => {
    const product = request.data?.productName ?? 'the product';
    const angles = ['PROBLEM_SOLUTION', 'BENEFIT', 'DEMONSTRATION', 'VALUE', 'SEASONAL'] as const;
    return {
      simulated: true,
      strategies: angles.slice(0, 3).map((angle) => ({
        angle,
        hypothesis: `A ${angle.toLowerCase().replace('_', '/')} angle may suit ${product}.`,
        hook: `${product}, shown plainly.`,
        suggestedCta: seededPick(`${product}${angle}`, ['Shop now', 'Learn more', 'See details']),
        assumptions: ['Generated locally without market data. Treat as a starting point.'],
        testingVariables: ['creative concept', 'headline'],
      })),
    };
  },

  'copy.generate': (request) => {
    const product = request.data?.productName ?? 'this product';
    // Composed strictly from supplied values: no claims, no statistics, no
    // scarcity, no superlatives. The prohibited-claims rules are satisfied by
    // construction rather than by filtering afterwards.
    return {
      simulated: true,
      variants: [
        {
          primaryText: `${product}. See the details and decide for yourself.`,
          headline: product,
          description: 'Available now.',
          cta: 'Shop now',
        },
        {
          primaryText: `Looking at ${product}? Here is what it is.`,
          headline: `About ${product}`,
          description: 'Full details on the product page.',
          cta: 'Learn more',
        },
      ],
    };
  },
};

class LocalAIProvider implements AIProvider {
  readonly descriptor = DESCRIPTOR;

  async complete<T>(request: AICompletionRequest<T>): Promise<ProviderResult<T>> {
    const handler = HANDLERS[request.task];
    if (!handler) {
      throw new AppError('CONFIGURATION_ERROR', `No local handler for AI task "${request.task}"`, {
        details: { task: request.task, available: Object.keys(HANDLERS) },
        publicMessage: 'This feature is not yet available in the free built-in provider.',
      });
    }

    // Validated exactly as a paid provider's output would be. If the local
    // provider drifts out of shape, tests fail here rather than downstream.
    const value = request.parse(handler(request as AICompletionRequest<unknown>));

    return { value, usage: FREE_USAGE(1, 'call') };
  }
}

export const createLocalAIProvider = (): AIProvider => new LocalAIProvider();
export const localAIDescriptor = DESCRIPTOR;

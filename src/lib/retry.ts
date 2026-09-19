import { toAppError, type AppError } from './errors';

/**
 * Bounded retry with exponential backoff and full jitter.
 *
 * Every external call in this system (crawler, AI provider, image provider,
 * Meta) routes through here. The rules from the spec are enforced by the
 * signature itself: `maxAttempts` is required, so "retry forever" is not
 * expressible.
 */

export interface RetryOptions {
  /** Total attempts including the first. Must be >= 1. */
  maxAttempts: number;
  /** Delay before the second attempt, in ms. Doubles each attempt. */
  baseDelayMs?: number;
  /** Ceiling on any single delay, in ms. */
  maxDelayMs?: number;
  /** Defaults to `AppError.retryable`; unknown errors are not retried. */
  isRetryable?: (error: AppError, attempt: number) => boolean;
  /** Called before each backoff wait — used for logging in callers. */
  onRetry?: (error: AppError, attempt: number, delayMs: number) => void;
  /** Injected in tests to avoid real waiting. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected in tests for deterministic jitter. Returns [0, 1). */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Computes the delay before the attempt following `attempt` (1-indexed),
 * using exponential growth with full jitter.
 *
 * Full jitter — a uniform draw from [0, exponential] rather than the
 * exponential itself — is what stops a batch of jobs that failed together
 * from retrying together.
 */
export function computeBackoffMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  return Math.round(random() * exponential);
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const {
    maxAttempts,
    baseDelayMs = 500,
    maxDelayMs = 30_000,
    isRetryable = (error) => error.retryable,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`maxAttempts must be a positive integer, received ${maxAttempts}`);
  }

  let lastError: AppError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (thrown) {
      const error = toAppError(thrown);
      lastError = error;

      const hasAttemptsLeft = attempt < maxAttempts;
      if (!hasAttemptsLeft || !isRetryable(error, attempt)) throw error;

      const delayMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs, random);
      onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw lastError ?? toAppError(new Error('withRetry exhausted without an error'));
}

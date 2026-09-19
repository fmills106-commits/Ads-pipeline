import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/lib/errors';
import { computeBackoffMs, withRetry } from '@/lib/retry';

const noSleep = async (): Promise<void> => undefined;
/** Full jitter at its maximum, so delays are predictable in assertions. */
const noJitter = () => 1;

describe('computeBackoffMs', () => {
  it('grows exponentially', () => {
    expect(computeBackoffMs(1, 500, 30_000, noJitter)).toBe(500);
    expect(computeBackoffMs(2, 500, 30_000, noJitter)).toBe(1_000);
    expect(computeBackoffMs(3, 500, 30_000, noJitter)).toBe(2_000);
    expect(computeBackoffMs(6, 500, 30_000, noJitter)).toBe(16_000);
  });

  it('clamps to maxDelayMs', () => {
    expect(computeBackoffMs(20, 500, 30_000, noJitter)).toBe(30_000);
  });

  it('applies full jitter — the delay is a draw from [0, exponential]', () => {
    expect(computeBackoffMs(3, 500, 30_000, () => 0)).toBe(0);
    expect(computeBackoffMs(3, 500, 30_000, () => 0.5)).toBe(1_000);
  });
});

describe('withRetry', () => {
  it('returns the first successful result without retrying', async () => {
    const operation = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(operation, { maxAttempts: 3, sleep: noSleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure and succeeds', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new AppError('PROVIDER_RATE_LIMITED', 'slow down'))
      .mockResolvedValue('ok');

    await expect(withRetry(operation, { maxAttempts: 3, sleep: noSleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable failure', async () => {
    const operation = vi.fn().mockRejectedValue(new AppError('PROVIDER_UNAUTHORIZED', 'bad token'));

    await expect(withRetry(operation, { maxAttempts: 5, sleep: noSleep })).rejects.toMatchObject({
      code: 'PROVIDER_UNAUTHORIZED',
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops at maxAttempts and rethrows the last error', async () => {
    const operation = vi.fn().mockRejectedValue(new AppError('PROVIDER_TIMEOUT', 'timeout'));

    await expect(withRetry(operation, { maxAttempts: 3, sleep: noSleep })).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('never retries forever — maxAttempts is required and bounded', async () => {
    await expect(withRetry(async () => 'x', { maxAttempts: 0, sleep: noSleep })).rejects.toThrow(
      RangeError,
    );
  });

  it('waits with increasing backoff between attempts', async () => {
    const delays: number[] = [];
    const operation = vi.fn().mockRejectedValue(new AppError('PROVIDER_TIMEOUT', 'timeout'));

    await withRetry(operation, {
      maxAttempts: 4,
      baseDelayMs: 100,
      random: noJitter,
      sleep: async (ms) => {
        delays.push(ms);
      },
    }).catch(() => undefined);

    expect(delays).toEqual([100, 200, 400]);
  });

  it('wraps non-AppError throws before deciding retryability', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('raw failure'));

    await expect(withRetry(operation, { maxAttempts: 3, sleep: noSleep })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    // An unrecognised error is not assumed safe to repeat.
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('honours a custom isRetryable predicate', async () => {
    const operation = vi.fn().mockRejectedValue(new AppError('VALIDATION_ERROR', 'nope'));

    await withRetry(operation, {
      maxAttempts: 3,
      sleep: noSleep,
      isRetryable: () => true,
    }).catch(() => undefined);

    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('reports each retry through onRetry', async () => {
    const seen: Array<{ attempt: number; code: string }> = [];
    const operation = vi.fn().mockRejectedValue(new AppError('PROVIDER_ERROR', 'boom'));

    await withRetry(operation, {
      maxAttempts: 3,
      sleep: noSleep,
      onRetry: (error, attempt) => seen.push({ attempt, code: error.code }),
    }).catch(() => undefined);

    expect(seen).toEqual([
      { attempt: 1, code: 'PROVIDER_ERROR' },
      { attempt: 2, code: 'PROVIDER_ERROR' },
    ]);
  });
});

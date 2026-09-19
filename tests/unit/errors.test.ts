import { describe, expect, it } from 'vitest';
import { AppError, isAppError, toAppError, notFound, tenantMismatch } from '@/lib/errors';

describe('AppError', () => {
  it('maps codes to HTTP statuses', () => {
    expect(new AppError('VALIDATION_ERROR', 'x').status).toBe(400);
    expect(new AppError('UNAUTHENTICATED', 'x').status).toBe(401);
    expect(new AppError('FORBIDDEN', 'x').status).toBe(403);
    expect(new AppError('NOT_FOUND', 'x').status).toBe(404);
    expect(new AppError('PROVIDER_TIMEOUT', 'x').status).toBe(504);
    expect(new AppError('INTERNAL_ERROR', 'x').status).toBe(500);
  });

  it('reports a cross-tenant reference as 404, not 403', () => {
    // Confirming that a resource exists in another workspace is itself a leak.
    expect(tenantMismatch('nope').status).toBe(404);
    expect(tenantMismatch('nope').publicMessage).toBe(notFound().publicMessage);
  });

  it('marks transient provider failures retryable and client errors not', () => {
    expect(new AppError('PROVIDER_RATE_LIMITED', 'x').retryable).toBe(true);
    expect(new AppError('PROVIDER_TIMEOUT', 'x').retryable).toBe(true);
    expect(new AppError('DATABASE_ERROR', 'x').retryable).toBe(true);

    expect(new AppError('VALIDATION_ERROR', 'x').retryable).toBe(false);
    expect(new AppError('PROVIDER_UNAUTHORIZED', 'x').retryable).toBe(false);
    expect(new AppError('BUDGET_LIMIT_EXCEEDED', 'x').retryable).toBe(false);
  });

  it('allows retryability to be overridden explicitly', () => {
    expect(new AppError('VALIDATION_ERROR', 'x', { retryable: true }).retryable).toBe(true);
  });

  it('keeps internal detail out of the public body', () => {
    const error = new AppError('PROVIDER_ERROR', 'Meta returned 500: token abc123 rejected', {
      details: { accountId: 'act_1', raw: 'token abc123' },
    });

    const body = error.toPublicJSON();
    expect(body.error.code).toBe('PROVIDER_ERROR');
    expect(body.error.message).not.toContain('abc123');
    expect(JSON.stringify(body)).not.toContain('act_1');
  });

  it('uses an explicit publicMessage when given', () => {
    const error = new AppError('CREATIVE_QA_FAILED', 'price mismatch 4.99 vs 9.99', {
      publicMessage: 'The creative showed a price that does not match the product.',
    });
    expect(error.toPublicJSON().error.message).toBe(
      'The creative showed a price that does not match the product.',
    );
  });

  it('preserves the cause chain', () => {
    const root = new Error('ECONNRESET');
    expect(new AppError('PROVIDER_ERROR', 'upstream failed', { cause: root }).cause).toBe(root);
  });
});

describe('toAppError', () => {
  it('returns AppErrors untouched', () => {
    const original = notFound('gone');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps a plain Error as INTERNAL_ERROR and keeps it as the cause', () => {
    const original = new Error('kaboom');
    const wrapped = toAppError(original);

    expect(isAppError(wrapped)).toBe(true);
    expect(wrapped.code).toBe('INTERNAL_ERROR');
    expect(wrapped.cause).toBe(original);
  });

  it('wraps non-Error throws without leaking their content', () => {
    const wrapped = toAppError({ weird: 'object' });
    expect(wrapped.code).toBe('INTERNAL_ERROR');
    expect(wrapped.toPublicJSON().error.message).toBe('Something went wrong.');
  });
});

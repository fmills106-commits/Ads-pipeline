/**
 * The application's error taxonomy.
 *
 * Every failure that crosses a module boundary should be an `AppError`. That
 * buys three things the platform needs:
 *
 *  - a stable machine-readable `code` for the UI and for structured logs,
 *  - a `retryable` flag the job runner uses to decide between backoff and
 *    dead-lettering (a rate limit is worth retrying; a 401 is not),
 *  - a `publicMessage` that is safe to show a user, kept separate from the
 *    internal `message`, so provider responses and stack details never leak.
 */

export const ERROR_CODES = [
  // --- client / request ---
  'VALIDATION_ERROR',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',

  // --- tenancy ---
  'TENANT_MISMATCH',

  // --- external systems ---
  'PROVIDER_ERROR',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAUTHORIZED',
  'PROVIDER_REJECTED',

  // --- domain ---
  'CRAWL_ERROR',
  'CRAWL_DISALLOWED',
  'AI_OUTPUT_INVALID',
  'CREATIVE_QA_FAILED',
  'BUDGET_LIMIT_EXCEEDED',
  'APPROVAL_REQUIRED',
  'AUTOMATION_NOT_PERMITTED',

  // --- infrastructure ---
  'DATABASE_ERROR',
  'CONFIGURATION_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** HTTP status for each code. Keeps route handlers free of mapping logic. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,

  // A cross-tenant reference is reported as 404, never 403: confirming that a
  // resource exists in someone else's workspace is itself a leak.
  TENANT_MISMATCH: 404,

  PROVIDER_ERROR: 502,
  PROVIDER_TIMEOUT: 504,
  PROVIDER_RATE_LIMITED: 429,
  PROVIDER_UNAUTHORIZED: 502,
  PROVIDER_REJECTED: 422,

  CRAWL_ERROR: 422,
  CRAWL_DISALLOWED: 403,
  AI_OUTPUT_INVALID: 502,
  CREATIVE_QA_FAILED: 422,
  BUDGET_LIMIT_EXCEEDED: 403,
  APPROVAL_REQUIRED: 403,
  AUTOMATION_NOT_PERMITTED: 403,

  DATABASE_ERROR: 500,
  CONFIGURATION_ERROR: 500,
  INTERNAL_ERROR: 500,
};

/** Codes worth retrying with backoff. Everything else fails fast. */
const RETRYABLE_CODES = new Set<ErrorCode>([
  'RATE_LIMITED',
  'PROVIDER_ERROR',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'DATABASE_ERROR',
]);

/** Shown to users when an error carries no explicit `publicMessage`. */
const GENERIC_PUBLIC_MESSAGE: Record<ErrorCode, string> = {
  VALIDATION_ERROR: 'Some of the information provided is not valid.',
  UNAUTHENTICATED: 'You need to sign in to continue.',
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_FOUND: 'That item could not be found.',
  CONFLICT: 'That change conflicts with the current state.',
  RATE_LIMITED: 'Too many requests. Please try again shortly.',
  PAYLOAD_TOO_LARGE: 'That upload is too large.',
  TENANT_MISMATCH: 'That item could not be found.',
  PROVIDER_ERROR: 'An external service failed. Please try again.',
  PROVIDER_TIMEOUT: 'An external service took too long to respond.',
  PROVIDER_RATE_LIMITED: 'An external service is rate limiting us. Please try again shortly.',
  PROVIDER_UNAUTHORIZED: 'The connection to an external service is no longer authorised.',
  PROVIDER_REJECTED: 'An external service rejected this request.',
  CRAWL_ERROR: 'The website could not be read.',
  CRAWL_DISALLOWED: 'This website does not permit automated access to that page.',
  AI_OUTPUT_INVALID: 'The AI response could not be used. Please try again.',
  CREATIVE_QA_FAILED: 'The generated creative did not pass quality checks.',
  BUDGET_LIMIT_EXCEEDED: 'That would exceed a configured spending limit.',
  APPROVAL_REQUIRED: 'This action requires approval first.',
  AUTOMATION_NOT_PERMITTED: 'The current automation level does not permit this action.',
  DATABASE_ERROR: 'A storage error occurred. Please try again.',
  CONFIGURATION_ERROR: 'The application is not configured correctly.',
  INTERNAL_ERROR: 'Something went wrong.',
};

export interface AppErrorOptions {
  /** Internal detail — structured, logged, never returned to the browser. */
  details?: Record<string, unknown>;
  /** Safe to display. Falls back to a generic message for the code. */
  publicMessage?: string;
  /** Overrides the code's default retryability. */
  retryable?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly publicMessage: string;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.publicMessage = options.publicMessage ?? GENERIC_PUBLIC_MESSAGE[code];
    if (options.details !== undefined) this.details = options.details;
    Error.captureStackTrace?.(this, AppError);
  }

  /** The body returned to clients. Internal `details` are deliberately absent. */
  toPublicJSON(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.publicMessage } };
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

// --- Constructors for the codes used often enough to deserve shorthand ------

export const validationError = (message: string, options?: AppErrorOptions) =>
  new AppError('VALIDATION_ERROR', message, options);

export const unauthenticated = (message = 'Not authenticated', options?: AppErrorOptions) =>
  new AppError('UNAUTHENTICATED', message, options);

export const forbidden = (message = 'Forbidden', options?: AppErrorOptions) =>
  new AppError('FORBIDDEN', message, options);

export const notFound = (message = 'Not found', options?: AppErrorOptions) =>
  new AppError('NOT_FOUND', message, options);

export const conflict = (message: string, options?: AppErrorOptions) =>
  new AppError('CONFLICT', message, options);

export const tenantMismatch = (message: string, options?: AppErrorOptions) =>
  new AppError('TENANT_MISMATCH', message, options);

export const internalError = (message = 'Internal error', options?: AppErrorOptions) =>
  new AppError('INTERNAL_ERROR', message, options);

/**
 * Normalises anything thrown into an `AppError`.
 *
 * The original value is preserved as `cause` so nothing is lost in logs, but
 * an unrecognised throw never becomes a user-visible message.
 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    return new AppError('INTERNAL_ERROR', value.message, { cause: value });
  }
  return new AppError('INTERNAL_ERROR', 'Unknown error thrown', {
    details: { thrown: typeof value },
    cause: value,
  });
}

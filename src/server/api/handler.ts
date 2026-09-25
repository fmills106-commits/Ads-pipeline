import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError, toAppError, validationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { uuid } from '@/lib/id';
import { requireCurrentUser } from '@/server/auth/current-user';
import {
  enforce,
  RATE_LIMITS,
  type RateLimitResult,
  type RateLimitRule,
} from '@/server/api/rate-limit';
import { clientIp } from '@/server/api/request';
import type { User } from '@prisma/client';

/**
 * The single entry point for every API route.
 *
 * Wrapping handlers here is what makes §41's "do not create inconsistent
 * endpoint conventions" enforceable rather than aspirational: request id,
 * structured logging, body validation, auth, and error-to-status mapping all
 * happen in one place, so a route handler contains only its own logic.
 */

export interface HandlerContext<TBody, TParams> {
  request: Request;
  body: TBody;
  params: TParams;
  requestId: string;
  user: User;
}

export interface AnonymousHandlerContext<TBody, TParams> {
  request: Request;
  body: TBody;
  params: TParams;
  requestId: string;
}

interface RouteOptions<TSchema extends ZodTypeAny | undefined> {
  /** Zod schema for the JSON body. Omit for GET/DELETE. */
  schema?: TSchema;
  /** Set false for endpoints reachable while signed out (login, register). */
  requireAuth?: boolean;
  /**
   * Rate limit for this route, counted before the handler runs.
   *
   * Authenticated routes are counted per user; anonymous ones per client IP,
   * and all together when no trusted proxy is configured (see `clientIp`).
   * Omitting it applies the `api` backstop to authenticated routes and
   * nothing to anonymous ones — a public route that needs a limit must say
   * so, because a wrong default here is either useless or a lockout.
   */
  rateLimit?: RateLimitRule;
}

type InferBody<TSchema> = TSchema extends ZodTypeAny ? z.infer<TSchema> : undefined;

/** Next.js passes route params as a promise in the App Router. */
type RouteParams = Record<string, string | string[] | undefined>;

/** Authenticated route. The handler receives a guaranteed non-null `user`. */
export function route<TSchema extends ZodTypeAny | undefined = undefined>(
  options: RouteOptions<TSchema> & { requireAuth?: true },
  handler: (context: HandlerContext<InferBody<TSchema>, RouteParams>) => Promise<unknown>,
): (request: Request, segment: { params: Promise<RouteParams> }) => Promise<NextResponse>;

/** Public route. No user is resolved. */
export function route<TSchema extends ZodTypeAny | undefined = undefined>(
  options: RouteOptions<TSchema> & { requireAuth: false },
  handler: (context: AnonymousHandlerContext<InferBody<TSchema>, RouteParams>) => Promise<unknown>,
): (request: Request, segment: { params: Promise<RouteParams> }) => Promise<NextResponse>;

export function route<TSchema extends ZodTypeAny | undefined = undefined>(
  options: RouteOptions<TSchema>,
  // The two overloads above are the public contract; internally the two context
  // shapes are unified, so this signature is intentionally the looser one.
  handler: (context: never) => Promise<unknown>,
): (request: Request, segment: { params: Promise<RouteParams> }) => Promise<NextResponse> {
  const { schema, requireAuth = true, rateLimit } = options;

  return async function handleRequest(
    request: Request,
    segment: { params: Promise<RouteParams> },
  ): Promise<NextResponse> {
    const requestId = uuid();
    const log = logger().child({
      requestId,
      method: request.method,
      path: new URL(request.url).pathname,
    });
    const startedAt = Date.now();

    /*
     * Whichever rate-limit check actually ran, so its count can be reported on
     * the way out. Undefined means no limit applied to this request.
     */
    let limitState: RateLimitResult | undefined;

    try {
      const params = (await segment?.params) ?? {};

      /*
       * An anonymous route is counted before its body is parsed and before
       * anything touches the database, because the point of limiting login
       * and register is to make a flood cheap to refuse. An authenticated
       * route is counted after the session lookup, so the subject can be the
       * user rather than an address several people may share.
       */
      if (!requireAuth && rateLimit) {
        limitState = await enforce(rateLimit, ipSubject(request));
      }

      const body = schema ? await parseBody(request, schema) : undefined;
      const user = requireAuth ? await requireCurrentUser() : undefined;

      if (user) {
        limitState = await enforce(rateLimit ?? RATE_LIMITS.api, `user:${user.id}`);
      }

      const result = await handler({
        request,
        body,
        params,
        requestId,
        ...(user ? { user } : {}),
      } as never);

      log.info('Request completed', { durationMs: Date.now() - startedAt, status: 200 });

      const headers = { 'x-request-id': requestId, ...rateLimitHeaders(limitState) };

      // A route that builds its own response — login, to set a cookie — still
      // gets the headers, rather than being the one case that reports nothing.
      if (result instanceof NextResponse) {
        for (const [name, value] of Object.entries(headers)) result.headers.set(name, value);
        return result;
      }
      if (result === undefined || result === null) {
        return NextResponse.json({ data: null }, { headers });
      }
      return NextResponse.json({ data: result }, { headers });
    } catch (thrown) {
      return respondWithError(thrown, requestId, log, Date.now() - startedAt, limitState);
    }
  };
}

/**
 * The subject an anonymous request is counted against.
 *
 * With no trusted proxy configured there is no address to believe, so every
 * anonymous caller shares one counter. That is deliberately the safe failure:
 * a misconfigured deployment throttles everyone together rather than trusting
 * a header an attacker sets. It is also why `TRUSTED_PROXY` is worth setting.
 */
function ipSubject(request: Request): string {
  return clientIp(request) ?? 'unidentified';
}

async function parseBody<TSchema extends ZodTypeAny>(
  request: Request,
  schema: TSchema,
): Promise<z.infer<TSchema>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw validationError('Request body must be valid JSON');
  }

  try {
    return schema.parse(raw) as z.infer<TSchema>;
  } catch (error) {
    if (error instanceof ZodError) {
      throw validationError('Request body failed validation', {
        details: { issues: error.issues },
        publicMessage: formatZodIssues(error),
      });
    }
    throw error;
  }
}

/** Turns Zod issues into one sentence a user can act on. */
function formatZodIssues(error: ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Some of the information provided is not valid.';
  const field = first.path.join('.');
  return field ? `${field}: ${first.message}` : first.message;
}

/**
 * What the limiter counted, as response headers.
 *
 * The conventional `x-ratelimit-*` trio, on every answer from a limited route
 * rather than only on a refusal. Exposing the remaining count gives an attacker
 * nothing they could not learn by counting their own requests, and it is the
 * only way to confirm from outside that the limiter is running at all — the
 * alternative being to exceed a login limit in production to see whether it
 * holds.
 *
 * `reset` is seconds until the window ends, not a timestamp, so it needs no
 * clock agreement between us and the caller.
 */
function rateLimitHeaders(state: RateLimitResult | undefined): Record<string, string> {
  if (!state) return {};
  return {
    'x-ratelimit-limit': String(state.limit),
    'x-ratelimit-remaining': String(state.remaining),
    'x-ratelimit-reset': String(state.retryAfterSeconds),
  };
}

function respondWithError(
  thrown: unknown,
  requestId: string,
  log: ReturnType<typeof logger>,
  durationMs: number,
  limitState?: RateLimitResult,
): NextResponse {
  const error = toAppError(thrown);

  // 5xx means we broke; 4xx means the caller did. Log accordingly so alerting
  // is not drowned in validation failures.
  const level = error.status >= 500 ? 'error' : 'warn';
  log[level]('Request failed', {
    durationMs,
    status: error.status,
    code: error.code,
    error,
  });

  const headers: Record<string, string> = {
    'x-request-id': requestId,
    ...rateLimitHeaders(limitState),
  };

  // A 429 without a Retry-After leaves a client guessing, which usually means
  // retrying immediately and making the problem worse.
  const retryAfter = error.details?.['retryAfterSeconds'];
  if (typeof retryAfter === 'number') headers['retry-after'] = String(retryAfter);

  /*
   * The refusal itself is the one case `limitState` cannot describe: `enforce`
   * throws instead of returning, so nothing was assigned. The rule's own
   * numbers travel on the error, and none remain by definition.
   */
  if (error.code === 'RATE_LIMITED' && typeof retryAfter === 'number') {
    const limit = error.details?.['limit'];
    if (typeof limit === 'number') headers['x-ratelimit-limit'] = String(limit);
    headers['x-ratelimit-remaining'] = '0';
    headers['x-ratelimit-reset'] = String(retryAfter);
  }

  return NextResponse.json(error.toPublicJSON(), { status: error.status, headers });
}

/** Re-exported so route files import one module. */
export { AppError };

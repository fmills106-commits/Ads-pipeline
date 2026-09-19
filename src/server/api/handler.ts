import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError, toAppError, validationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { uuid } from '@/lib/id';
import { requireCurrentUser } from '@/server/auth/current-user';
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
  const { schema, requireAuth = true } = options;

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

    try {
      const params = (await segment?.params) ?? {};
      const body = schema ? await parseBody(request, schema) : undefined;
      const user = requireAuth ? await requireCurrentUser() : undefined;

      const result = await handler({
        request,
        body,
        params,
        requestId,
        ...(user ? { user } : {}),
      } as never);

      log.info('Request completed', { durationMs: Date.now() - startedAt, status: 200 });

      if (result instanceof NextResponse) return result;
      if (result === undefined || result === null) {
        return NextResponse.json({ data: null }, { headers: { 'x-request-id': requestId } });
      }
      return NextResponse.json({ data: result }, { headers: { 'x-request-id': requestId } });
    } catch (thrown) {
      return respondWithError(thrown, requestId, log, Date.now() - startedAt);
    }
  };
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

function respondWithError(
  thrown: unknown,
  requestId: string,
  log: ReturnType<typeof logger>,
  durationMs: number,
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

  return NextResponse.json(error.toPublicJSON(), {
    status: error.status,
    headers: { 'x-request-id': requestId },
  });
}

/** Re-exported so route files import one module. */
export { AppError };

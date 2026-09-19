import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Session, User } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { getEnv } from '@/lib/env';
import { unauthenticated } from '@/lib/errors';

/**
 * Database-backed sessions in an httpOnly cookie.
 *
 * The cookie carries a 32-byte random token. What is stored is an HMAC of that
 * token keyed with AUTH_SECRET — so a leaked database snapshot yields no usable
 * sessions, and revocation is a single DELETE (which a stateless JWT could not
 * give us; revoking a creative-approval session needs to be immediate).
 */

export const SESSION_COOKIE_NAME = 'ads_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_BYTES = 32;

/** Keyed hash of a raw session token. Deterministic, so it can be looked up. */
export function hashSessionToken(token: string): string {
  return createHmac('sha256', getEnv().AUTH_SECRET).update(token).digest('hex');
}

export function generateSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export interface CreateSessionInput {
  userId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  now?: Date;
}

/** Creates a session row and returns the raw token — the only time it exists. */
export async function createSession(
  input: CreateSessionInput,
  db: Db = prisma,
): Promise<{ token: string; session: Session }> {
  const token = generateSessionToken();
  const now = input.now ?? new Date();

  const session = await db.session.create({
    data: {
      tokenHash: hashSessionToken(token),
      userId: input.userId,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      ipAddress: input.ipAddress ?? null,
      userAgent: truncate(input.userAgent, 512),
    },
  });

  return { token, session };
}

export interface ResolvedSession {
  session: Session;
  user: User;
}

/**
 * Looks up a session by raw token.
 *
 * Returns `null` for absent, unknown, or expired tokens — callers decide
 * whether that is a redirect or a 401. Expired rows are deleted on sight so
 * the table does not grow without bound between sweeps.
 */
export async function resolveSession(
  token: string | undefined | null,
  db: Db = prisma,
  now: Date = new Date(),
): Promise<ResolvedSession | null> {
  if (!token) return null;

  const tokenHash = hashSessionToken(token);
  const session = await db.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });
  if (!session) return null;

  // Defence in depth: the lookup above is already by exact hash, but comparing
  // in constant time keeps the pattern consistent wherever tokens are compared.
  if (!constantTimeEqual(session.tokenHash, tokenHash)) return null;

  if (session.expiresAt.getTime() <= now.getTime()) {
    // deleteMany, not delete: a concurrent request may have swept it already.
    await db.session.deleteMany({ where: { id: session.id } });
    return null;
  }

  const { user, ...rest } = session;
  return { session: rest, user };
}

/** Like `resolveSession`, but throws `UNAUTHENTICATED` instead of returning null. */
export async function requireSession(
  token: string | undefined | null,
  db: Db = prisma,
): Promise<ResolvedSession> {
  const resolved = await resolveSession(token, db);
  if (!resolved) throw unauthenticated('No valid session for request');
  return resolved;
}

/** Idempotent by construction: `deleteMany` on an absent row is a no-op. */
export async function destroySession(token: string, db: Db = prisma): Promise<void> {
  await db.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
}

/** Signs every device out — used on password change and on demand. */
export async function destroyAllUserSessions(userId: string, db: Db = prisma): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { userId } });
  return count;
}

/** Housekeeping, run from a scheduled job. */
export async function purgeExpiredSessions(
  db: Db = prisma,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}

/** Cookie attributes. `secure` is on everywhere except plain-HTTP localhost. */
export function sessionCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  const env = getEnv();
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.APP_URL.startsWith('https://'),
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

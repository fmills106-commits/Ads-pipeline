import { prisma } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { Db } from '@/lib/db';

/**
 * Fixed-window rate limiting, counted in Postgres.
 *
 * Why here and not in a proxy: the limits that matter are per-account and
 * per-business, not per-URL, and only the application knows which business a
 * request belongs to. Cloudflare can shed a flood at the edge; it cannot tell
 * that one signed-in user is scanning the same site forty times an hour.
 *
 * Why fixed windows and not a token bucket: a fixed window is one atomic
 * statement and cannot drift, and the failure mode — up to 2× the limit across
 * a window boundary — is irrelevant at these magnitudes. A bucket would need
 * either a read-modify-write race or a stored procedure to be correct.
 *
 * Why counting at all, given the crawler is already polite: politeness governs
 * how fast one scan hits one host. It says nothing about a caller starting a
 * hundred scans, or about somebody working through a password list.
 */

export interface RateLimitRule {
  /** Namespace for the counter, e.g. `login`. */
  action: string;
  /** Requests permitted per window. */
  limit: number;
  windowMs: number;
}

/**
 * The limits in force.
 *
 * Deliberately generous for things a real person does and tight for things
 * only a script does. These are not tuning knobs exposed to the owner — §"the
 * complexity belongs in the software" — so they live in code, not config.
 */
export const RATE_LIMITS = {
  /** Credential stuffing is the threat; 10 tries in 15 minutes is plenty. */
  login: { action: 'login', limit: 10, windowMs: 15 * 60 * 1000 },
  /** Signup floods create workspaces and rows; a person needs one. */
  register: { action: 'register', limit: 5, windowMs: 60 * 60 * 1000 },
  /**
   * A scan fetches somebody else's server, so this protects a third party as
   * much as us. Ten an hour is far more than a real site needs.
   */
  scan: { action: 'scan', limit: 10, windowMs: 60 * 60 * 1000 },
  /** A backstop on everything else an authenticated caller can do. */
  api: { action: 'api', limit: 300, windowMs: 60 * 1000 },
} as const satisfies Record<string, RateLimitRule>;

export interface RateLimitResult {
  allowed: boolean;
  /** Requests left in this window, never negative. */
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
}

/**
 * Counts one request against a rule and reports whether it may proceed.
 *
 * The count happens in a single `INSERT … ON CONFLICT DO UPDATE`, so
 * concurrent requests cannot both read the same count and both decide they
 * are under the limit. The window start is truncated to the window size,
 * which is what lets the same statement reset a stale window instead of
 * needing a separate read to notice it expired.
 */
export async function consume(
  rule: RateLimitRule,
  subject: string,
  db: Db = prisma,
  now: Date = new Date(),
): Promise<RateLimitResult> {
  const windowStart = new Date(Math.floor(now.getTime() / rule.windowMs) * rule.windowMs);
  const expiresAt = new Date(windowStart.getTime() + rule.windowMs);
  const key = `${rule.action}:${subject}`.slice(0, 512);

  const retryAfterSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));

  let count: number;
  try {
    const rows = await db.$queryRaw<Array<{ count: number }>>`
      INSERT INTO rate_limits ("key", "windowStart", "count", "expiresAt")
      VALUES (${key}, ${windowStart}, 1, ${expiresAt})
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE
          WHEN rate_limits."windowStart" = ${windowStart} THEN rate_limits."count" + 1
          ELSE 1
        END,
        "windowStart" = ${windowStart},
        "expiresAt" = ${expiresAt}
      RETURNING "count"
    `;
    count = rows[0]?.count ?? 1;
  } catch (cause) {
    /*
     * A limiter that fails closed would take the whole application down with
     * the counter table. Fail open, but say so loudly: this is the one place
     * in the codebase where losing a security control is preferable to
     * refusing every request, and it should never be silent.
     */
    logger().error('Rate limit check failed; allowing the request', {
      action: rule.action,
      error: cause,
    });
    return { allowed: true, remaining: rule.limit, retryAfterSeconds };
  }

  return {
    allowed: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfterSeconds,
  };
}

/**
 * Counts one request and throws when it is over the limit.
 *
 * `retryAfterSeconds` travels on the error's details so the route wrapper can
 * put it in a `Retry-After` header — a 429 without one tells a client nothing
 * except to guess.
 */
export async function enforce(
  rule: RateLimitRule,
  subject: string,
  db: Db = prisma,
): Promise<void> {
  const result = await consume(rule, subject, db);
  if (result.allowed) return;

  throw new AppError('RATE_LIMITED', `Rate limit exceeded for ${rule.action}`, {
    retryable: true,
    details: { action: rule.action, retryAfterSeconds: result.retryAfterSeconds },
  });
}

/**
 * Deletes counters whose window has passed.
 *
 * Called from the scheduled worker. Skipping it leaks one row per distinct
 * subject rather than breaking anything, which is why it is housekeeping and
 * not part of the hot path.
 */
export async function purgeExpiredRateLimits(
  db: Db = prisma,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await db.rateLimit.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}

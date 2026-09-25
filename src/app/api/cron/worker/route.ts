import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import { registerScannerJobs } from '@/server/scanner/job';
import { drainQueue } from '@/server/jobs/worker';
import { queueDepth, reclaimStalledJobs } from '@/server/jobs/queue';
import { purgeExpiredSessions } from '@/server/auth/session';
import { purgeExpiredRateLimits } from '@/server/api/rate-limit';

/**
 * The scheduled worker, for deployments with no always-on process.
 *
 * `npm run worker` is still the better way to run this when a host will let a
 * process live — it picks work up in seconds rather than whenever the schedule
 * fires. But a serverless deployment has nowhere to put that process, and
 * without *something* calling this endpoint a queued scan would sit there
 * forever, which is the single most likely way this application could look
 * broken after a deploy.
 *
 * It also does the housekeeping nothing else was calling: expired sessions and
 * spent rate-limit counters. Both leak rows rather than break anything, which
 * is precisely why they need a scheduled owner instead of a hot path.
 *
 * Deliberately NOT wrapped in `route()`: this is machine-to-machine, so it
 * takes a shared secret rather than a session, and it must not be counted
 * against a per-user rate limit.
 */

// Long-running by design; it drains until its budget is spent.
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorised(request: Request): boolean {
  const expected = getEnv().CRON_SECRET;

  // No secret configured means this endpoint is not in use. Refuse rather
  // than default to open — an unauthenticated drain is a free way to burn
  // every tenant's crawl allowance. Production boot already requires one.
  if (!expected) return false;

  const header = request.headers.get('authorization') ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Vercel Cron sends the secret as a bearer token; a plain header is
  // accepted too so any scheduler can call this.
  const presented = bearer || (request.headers.get('x-cron-secret') ?? '');

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  // Compare in constant time, and only when the lengths already match —
  // `timingSafeEqual` throws on a length mismatch.
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(request: Request): Promise<NextResponse> {
  if (!authorised(request)) {
    // Deliberately terse. A scheduler does not need an explanation, and an
    // unauthorised caller should learn nothing about why it failed.
    return NextResponse.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 });
  }

  const env = getEnv();
  const log = logger().child({ component: 'cron-worker' });
  const startedAt = Date.now();

  registerScannerJobs();

  // Before claiming anything: return work orphaned by an invocation that was
  // killed. On a serverless host this is the normal case, not an emergency.
  const reclaimed = await reclaimStalledJobs();

  /*
   * Leave a margin under the configured budget. The drain checks its deadline
   * between jobs, so the last job it starts can still overrun; the remaining
   * time is what lets this respond instead of being cut off mid-response.
   */
  const processed = await drainQueue({ budgetMs: Math.floor(env.WORKER_MAX_RUN_MS * 0.85) });

  const [sessions, rateLimits] = await Promise.all([
    purgeExpiredSessions().catch((error: unknown) => {
      log.warn('Session purge failed', { error });
      return 0;
    }),
    purgeExpiredRateLimits().catch((error: unknown) => {
      log.warn('Rate-limit purge failed', { error });
      return 0;
    }),
  ]);

  const body = {
    processed,
    reclaimed,
    purged: { sessions, rateLimits },
    durationMs: Date.now() - startedAt,
  };

  log.info('Scheduled worker finished', body);
  return NextResponse.json({ data: body });
}

/** GET, because most schedulers (Vercel Cron included) only issue GETs. */
export const GET = handle;
export const POST = handle;

/**
 * Queue depth without running anything, for a health check or an uptime
 * monitor. Same secret: depth across all tenants is not public information.
 */
export async function HEAD(request: Request): Promise<NextResponse> {
  if (!authorised(request)) return new NextResponse(null, { status: 401 });
  const depth = await queueDepth();
  return new NextResponse(null, {
    status: 200,
    headers: { 'x-queue-pending': String(depth.pending) },
  });
}

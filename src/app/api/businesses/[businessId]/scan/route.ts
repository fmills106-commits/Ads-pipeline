import { z } from 'zod';
import { getEnv } from '@/lib/env';
import { validationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { route } from '@/server/api/handler';
import { RATE_LIMITS } from '@/server/api/rate-limit';
import { getScanStatus, startScan } from '@/server/scanner/service';
import { registerScannerJobs } from '@/server/scanner/job';
import { drainQueue, kickQueue } from '@/server/jobs/worker';
import { JOB_TYPES } from '@/server/jobs/types';
import { requireBusinessContext } from '@/server/tenancy/context';

// Handlers must be registered in whichever process runs the job. Importing
// here means a single-process development server can execute scans without a
// separate worker; `npm run worker` registers them the same way.
registerScannerJobs();

const startSchema = z.object({
  /** Optional override; defaults to the business's configured website. */
  url: z.string().url().max(2048).optional(),
});

/** POST /api/businesses/:businessId/scan — queue a scan. */
export const POST = route(
  { schema: startSchema, rateLimit: RATE_LIMITS.scan },
  async ({ body, params, user }) => {
    const businessId = params.businessId;
    if (typeof businessId !== 'string') throw validationError('businessId is required');

    const context = await requireBusinessContext(user, businessId, { minimumRole: 'MEMBER' });
    /*
     * This endpoint only ever runs inside a request from a signed-in member,
     * so it is the one caller that can honestly claim a person asked. That is
     * what allows a site to be read while advertising is paused.
     */
    const result = await startScan(context, {
      trigger: 'OWNER',
      ...(body.url === undefined ? {} : { url: body.url }),
    });

    // Best-effort: starts the work now in single-process deployments. Production
    // runs a dedicated worker, which would pick this up regardless.
    kickQueue([JOB_TYPES.websiteScan]);

    return {
      scanRunId: result.scanRun.id,
      jobId: result.jobId,
      status: result.scanRun.status,
      requestedUrl: result.scanRun.requestedUrl,
      alreadyRunning: !result.created,
    };
  },
);

/**
 * GET /api/businesses/:businessId/scan — poll the latest scan, and move it along.
 *
 * The polling is also the worker, and that is not a shortcut. A serverless host
 * gives the application nowhere to keep a process, so the queue is drained by
 * something outside it — a scheduled GitHub workflow asking for every five
 * minutes. Measured against the real run history, GitHub delivered that roughly
 * **every two to four hours**. An owner pressed "Read my website", watched
 * "Reading your site" for twenty minutes, and reasonably concluded it was
 * broken. It was not: it was queued behind a scheduler that had not come.
 *
 * `kickQueue` in the POST above was supposed to cover this, and cannot: it is
 * deliberately not awaited, and a serverless invocation is frozen the moment it
 * responds, so the work it starts is killed before it does anything.
 *
 * So the drain happens here, where somebody is demonstrably waiting for the
 * answer. The page polls every two seconds while a scan is running, and each
 * poll now claims and runs the work it is asking about. Nothing new to deploy,
 * nothing to pay for, and the scheduled worker stays exactly as it was — the
 * safety net for anything queued by a page nobody is looking at.
 *
 * Costs nothing when the queue is empty: claiming is one indexed query that
 * returns no row, and the drain stops immediately.
 */
export const GET = route({}, async ({ params, user }) => {
  const businessId = params.businessId;
  if (typeof businessId !== 'string') throw validationError('businessId is required');

  const context = await requireBusinessContext(user, businessId);

  /*
   * Bounded well inside the function's own limit, so a scan that outruns it is
   * cut short and returned to the queue by the stall reclaimer rather than
   * killed mid-write. The next poll, two seconds later, picks it up again.
   */
  await drainQueue({
    maxJobs: 1,
    budgetMs: Math.min(45_000, Math.floor(getEnv().WORKER_MAX_RUN_MS * 0.85)),
    types: [JOB_TYPES.websiteScan],
  }).catch((error: unknown) => {
    // A failed job records its own failure and the status below reports it.
    // Failing the poll as well would tell the owner nothing and hide the state.
    logger().warn('Draining the queue from a scan poll failed', { error });
  });

  const status = await getScanStatus(context);

  return {
    phase: status.phase,
    scanRunId: status.scanRun?.id ?? null,
    status: status.scanRun?.status ?? null,
    requestedUrl: status.scanRun?.requestedUrl ?? null,
    startedAt: status.scanRun?.startedAt?.toISOString() ?? null,
    finishedAt: status.scanRun?.finishedAt?.toISOString() ?? null,
    stopReason: status.scanRun?.stopReason ?? null,
    pagesFetched: status.pagesFetched,
    pagesSkipped: status.scanRun?.pagesSkipped ?? 0,
    productsFound: status.productsFound,
    factsExtracted: status.factsExtracted,
    changeSummary: status.changeSummary,
    // Capped: a crawl can accumulate many warnings and the UI shows a summary.
    warnings: status.warnings.slice(0, 25),
  };
});

import { toAppError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { prisma, type Db } from '@/lib/db';
import { claimNextJob, completeJob, failJob, reclaimStalledJobs } from './queue';
import { JOB_TYPES, type JobType } from './types';
import type { Prisma } from '@prisma/client';

/**
 * The job runner.
 *
 * Handlers are registered rather than imported directly so this module has no
 * dependency on any particular job's implementation — which also keeps the
 * import graph acyclic when a handler needs the queue to enqueue follow-up work.
 */

export type JobHandler = (payload: unknown, job: { id: string }) => Promise<Prisma.InputJsonValue>;

const handlers = new Map<JobType, JobHandler>();

export function registerJobHandler(type: JobType, handler: JobHandler): void {
  handlers.set(type, handler);
}

/** Test-only. */
export function resetJobHandlers(): void {
  handlers.clear();
}

export interface RunOneResult {
  ran: boolean;
  jobId?: string;
  outcome?: 'succeeded' | 'retrying' | 'dead';
}

/**
 * Claims and runs at most one job.
 *
 * Returns `{ ran: false }` when the queue is empty, which is what lets the
 * caller decide between sleeping and exiting.
 */
export async function runOneJob(
  options: { types?: JobType[]; db?: Db } = {},
): Promise<RunOneResult> {
  const db = options.db ?? prisma;
  const job = await claimNextJob(options.types ? { types: options.types } : {}, db);
  if (!job) return { ran: false };

  const log = logger().child({ jobId: job.id, jobType: job.type, businessId: job.businessId });
  const handler = handlers.get(job.type as JobType);

  if (!handler) {
    // An unknown type is a deployment error, not a transient fault: retrying
    // would just burn attempts against a handler that does not exist.
    await failJob(
      job.id,
      {
        code: 'CONFIGURATION_ERROR',
        message: `No handler registered for job type "${job.type}"`,
        retryable: false,
      },
      db,
    );
    log.error('No handler for job type');
    return { ran: true, jobId: job.id, outcome: 'dead' };
  }

  const startedAt = Date.now();
  try {
    const result = await handler(job.payload, { id: job.id });
    await completeJob(job.id, result, db);
    log.info('Job completed', { durationMs: Date.now() - startedAt });
    return { ran: true, jobId: job.id, outcome: 'succeeded' };
  } catch (thrown) {
    const error = toAppError(thrown);
    const { willRetry } = await failJob(
      job.id,
      { code: error.code, message: error.message, retryable: error.retryable },
      db,
    );
    log.warn('Job threw', { code: error.code, willRetry, durationMs: Date.now() - startedAt });
    return { ran: true, jobId: job.id, outcome: willRetry ? 'retrying' : 'dead' };
  }
}

/**
 * Drains the queue until it is empty.
 *
 * Bounded by `maxJobs` so a test cannot spin forever and so a request-triggered
 * drain cannot run away. Used by the worker loop and by tests.
 */
export async function drainQueue(
  options: { maxJobs?: number; types?: JobType[]; db?: Db } = {},
): Promise<number> {
  const maxJobs = options.maxJobs ?? 100;
  let processed = 0;

  while (processed < maxJobs) {
    const result = await runOneJob({
      ...(options.types ? { types: options.types } : {}),
      ...(options.db ? { db: options.db } : {}),
    });
    if (!result.ran) break;
    processed += 1;
  }

  return processed;
}

/**
 * The long-running worker loop, for `npm run worker`.
 *
 * Polls rather than listens: at this scale a 2-second poll costs one trivial
 * indexed query and avoids LISTEN/NOTIFY connection management entirely.
 */
export async function runWorkerLoop(
  options: { pollMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 2_000;
  const log = logger().child({ component: 'worker' });

  await reclaimStalledJobs();
  log.info('Worker started', { pollMs, types: Object.values(JOB_TYPES) });

  while (!options.signal?.aborted) {
    let didWork = false;
    try {
      const result = await runOneJob();
      didWork = result.ran;
    } catch (error) {
      // A throw here means the queue itself is unhealthy (database down, say).
      // Log and keep polling; the next tick may succeed.
      log.error('Worker iteration failed', { error });
    }

    if (!didWork) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      await reclaimStalledJobs().catch(() => undefined);
    }
  }

  log.info('Worker stopped');
}

/**
 * Fire-and-forget drain, for triggering work from a request handler.
 *
 * A convenience for single-process development so a scan starts without a
 * separate worker running. Production should run `npm run worker`, because a
 * serverless request can be frozen the moment it responds — which is exactly
 * why this is explicitly best-effort and never awaited for correctness.
 */
export function kickQueue(types?: JobType[]): void {
  void drainQueue({ maxJobs: 5, ...(types ? { types } : {}) }).catch((error: unknown) => {
    logger().warn('Background queue drain failed', { error });
  });
}

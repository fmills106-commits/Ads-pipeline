import { Prisma, type Job } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { validationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import { computeBackoffMs } from '@/lib/retry';
import { JOB_LIMITS, JOB_PAYLOAD_SCHEMAS, type JobPayloads, type JobType } from './types';

/**
 * A database-backed job queue.
 *
 * PostgreSQL, not Redis: `SELECT … FOR UPDATE SKIP LOCKED` gives safe
 * multi-worker claiming with no second datastore to run, back up or pay for.
 * That matters for a project whose whole premise is $0 operation.
 *
 * The Job table shipped in Phase 1 with no code behind it. This is that code.
 */

export interface EnqueueOptions<T extends JobType> {
  type: T;
  payload: JobPayloads[T];
  workspaceId: string;
  businessId?: string | null;
  priority?: number;
  /** Delay before the job becomes claimable. */
  delayMs?: number;
  /**
   * Makes enqueueing idempotent. Re-enqueuing the same key returns the existing
   * job instead of creating a second one — which is what stops a
   * double-clicked "Scan website" button from crawling the site twice.
   */
  idempotencyKey?: string;
}

export interface EnqueueResult {
  job: Job;
  /** False when an existing job with the same idempotency key was returned. */
  created: boolean;
}

export async function enqueue<T extends JobType>(
  options: EnqueueOptions<T>,
  db: Db = prisma,
): Promise<EnqueueResult> {
  const schema = JOB_PAYLOAD_SCHEMAS[options.type];
  const parsed = schema.safeParse(options.payload);
  if (!parsed.success) {
    throw validationError(`Invalid payload for job ${options.type}`, {
      details: { issues: parsed.error.issues },
    });
  }

  const limits = JOB_LIMITS[options.type];
  const runAt = new Date(Date.now() + (options.delayMs ?? 0));

  if (options.idempotencyKey !== undefined) {
    const existing = await db.job.findUnique({
      where: { idempotencyKey: options.idempotencyKey },
    });
    if (existing) return { job: existing, created: false };
  }

  try {
    const job = await db.job.create({
      data: {
        type: options.type,
        workspaceId: options.workspaceId,
        businessId: options.businessId ?? null,
        payload: parsed.data as Prisma.InputJsonValue,
        priority: options.priority ?? 0,
        maxAttempts: limits.maxAttempts,
        runAt,
        idempotencyKey: options.idempotencyKey ?? null,
      },
    });

    logger().info('Job enqueued', { jobId: job.id, type: job.type, businessId: job.businessId });
    return { job, created: true };
  } catch (error) {
    // Two concurrent enqueues with the same key: the unique constraint is the
    // real guard, so lose the race gracefully and return the winner's row.
    if (isUniqueViolation(error) && options.idempotencyKey !== undefined) {
      const existing = await db.job.findUnique({
        where: { idempotencyKey: options.idempotencyKey },
      });
      if (existing) return { job: existing, created: false };
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
  );
}

/**
 * Claims one runnable job.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes this safe with several workers: each
 * transaction locks a different row instead of queueing behind the same one.
 * Returns null when there is nothing to do.
 */
export async function claimNextJob(
  options: { types?: JobType[]; now?: Date } = {},
  db: Db = prisma,
): Promise<Job | null> {
  const now = options.now ?? new Date();
  const types = options.types;

  const rows = types
    ? await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM jobs
        WHERE status = 'PENDING' AND "runAt" <= ${now} AND type IN (${Prisma.join(types)})
        ORDER BY priority DESC, "runAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`
    : await db.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM jobs
        WHERE status = 'PENDING' AND "runAt" <= ${now}
        ORDER BY priority DESC, "runAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`;

  const id = rows[0]?.id;
  if (!id) return null;

  // The conditional update is a second line of defence: if another worker got
  // there first despite the lock, `count` is 0 and we simply return null.
  const { count } = await db.job.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'RUNNING', startedAt: now, attempts: { increment: 1 } },
  });
  if (count === 0) return null;

  return db.job.findUnique({ where: { id } });
}

export async function completeJob(
  jobId: string,
  result: Prisma.InputJsonValue,
  db: Db = prisma,
): Promise<void> {
  await db.job.update({
    where: { id: jobId },
    data: { status: 'SUCCEEDED', completedAt: new Date(), result },
  });
}

export interface FailJobOptions {
  code: string;
  message: string;
  /** False forces dead-lettering regardless of attempts remaining. */
  retryable?: boolean;
}

/**
 * Records a failure and decides between another attempt and dead-lettering.
 *
 * Backoff reuses `computeBackoffMs` from the retry module — exponential with
 * full jitter — so a batch of jobs that failed together does not all wake at
 * the same moment and fail together again.
 */
export async function failJob(
  jobId: string,
  options: FailJobOptions,
  db: Db = prisma,
): Promise<{ willRetry: boolean }> {
  const job = await db.job.findUnique({ where: { id: jobId } });
  if (!job) return { willRetry: false };

  const retryable = options.retryable ?? true;
  const attemptsLeft = job.attempts < job.maxAttempts;
  const willRetry = retryable && attemptsLeft;

  const lastError = {
    code: options.code,
    message: options.message,
    attempt: job.attempts,
    at: new Date().toISOString(),
  };

  if (willRetry) {
    const delayMs = computeBackoffMs(job.attempts, 2_000, 60_000);
    await db.job.update({
      where: { id: jobId },
      data: {
        status: 'PENDING',
        runAt: new Date(Date.now() + delayMs),
        lastError,
      },
    });
    logger().warn('Job failed, will retry', {
      jobId,
      type: job.type,
      attempt: job.attempts,
      delayMs,
      code: options.code,
    });
    return { willRetry: true };
  }

  await db.job.update({
    where: { id: jobId },
    data: {
      // DEAD, not FAILED: retries are exhausted and it will never be picked up
      // again automatically. The distinction matters when reading the table.
      status: attemptsLeft ? 'FAILED' : 'DEAD',
      completedAt: new Date(),
      lastError,
    },
  });
  logger().error('Job failed permanently', {
    jobId,
    type: job.type,
    attempts: job.attempts,
    code: options.code,
  });
  return { willRetry: false };
}

/**
 * Returns jobs stuck in RUNNING past their lease to PENDING.
 *
 * A worker killed mid-job leaves its row RUNNING forever otherwise. Called by
 * the worker loop on startup and periodically.
 */
export async function reclaimStalledJobs(now: Date = new Date(), db: Db = prisma): Promise<number> {
  let reclaimed = 0;

  for (const [type, limits] of Object.entries(JOB_LIMITS)) {
    const cutoff = new Date(now.getTime() - limits.leaseMs);
    const { count } = await db.job.updateMany({
      where: { type, status: 'RUNNING', startedAt: { lt: cutoff } },
      data: { status: 'PENDING', runAt: now },
    });
    reclaimed += count;
  }

  if (reclaimed > 0) logger().warn('Reclaimed stalled jobs', { reclaimed });
  return reclaimed;
}

export async function getJob(jobId: string, db: Db = prisma): Promise<Job | null> {
  return db.job.findUnique({ where: { id: jobId } });
}

/** Pending + running count, for the UI and for tests. */
export async function queueDepth(
  workspaceId: string,
  db: Db = prisma,
): Promise<{ pending: number; running: number }> {
  const [pending, running] = await Promise.all([
    db.job.count({ where: { workspaceId, status: 'PENDING' } }),
    db.job.count({ where: { workspaceId, status: 'RUNNING' } }),
  ]);
  return { pending, running };
}

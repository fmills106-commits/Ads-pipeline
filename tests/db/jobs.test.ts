import { beforeEach, describe, expect, it } from 'vitest';
import type { User, Workspace } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  claimNextJob,
  completeJob,
  enqueue,
  failJob,
  queueDepth,
  reclaimStalledJobs,
} from '@/server/jobs/queue';
import { drainQueue, registerJobHandler, resetJobHandlers, runOneJob } from '@/server/jobs/worker';
import { JOB_TYPES } from '@/server/jobs/types';
import { createTestUser, createTestWorkspace, resetDatabase } from '../helpers/db';

/**
 * The queue shipped as a table in Phase 1 with no code. These tests cover the
 * code added in Phase 2, with emphasis on the parts that go wrong in
 * production: double-claiming, retry storms, and jobs orphaned by a dead worker.
 */

let user: User;
let workspace: Workspace;

const payload = () => ({
  scanRunId: crypto.randomUUID(),
  businessId: crypto.randomUUID(),
  requestedUrl: 'https://example.com/',
  isRescan: false,
});

beforeEach(async () => {
  await resetDatabase();
  resetJobHandlers();
  user = await createTestUser();
  workspace = await createTestWorkspace(user);
});

describe('enqueue', () => {
  it('creates a pending job', async () => {
    const { job, created } = await enqueue({
      type: JOB_TYPES.websiteScan,
      workspaceId: workspace.id,
      payload: payload(),
    });

    expect(created).toBe(true);
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(0);
  });

  it('validates the payload at enqueue time, not in the worker', async () => {
    await expect(
      enqueue({
        type: JOB_TYPES.websiteScan,
        workspaceId: workspace.id,
        // @ts-expect-error deliberately malformed
        payload: { nonsense: true },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('returns the existing job for a repeated idempotency key', async () => {
    // What stops a double-clicked "Scan website" button crawling twice.
    const key = 'scan:abc';
    const first = await enqueue({
      type: JOB_TYPES.websiteScan,
      workspaceId: workspace.id,
      payload: payload(),
      idempotencyKey: key,
    });
    const second = await enqueue({
      type: JOB_TYPES.websiteScan,
      workspaceId: workspace.id,
      payload: payload(),
      idempotencyKey: key,
    });

    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(await prisma.job.count()).toBe(1);
  });

  it('survives a concurrent race on the same idempotency key', async () => {
    const key = 'scan:race';
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        enqueue({
          type: JOB_TYPES.websiteScan,
          workspaceId: workspace.id,
          payload: payload(),
          idempotencyKey: key,
        }),
      ),
    );

    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await prisma.job.count()).toBe(1);
  });

  it('honours a delay', async () => {
    const { job } = await enqueue({
      type: JOB_TYPES.websiteScan,
      workspaceId: workspace.id,
      payload: payload(),
      delayMs: 60_000,
    });

    expect(job.runAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
    // Not claimable yet.
    expect(await claimNextJob()).toBeNull();
  });
});

describe('claiming', () => {
  it('claims a pending job and marks it running', async () => {
    await enqueue({ type: JOB_TYPES.websiteScan, workspaceId: workspace.id, payload: payload() });

    const job = await claimNextJob();
    expect(job?.status).toBe('RUNNING');
    expect(job?.attempts).toBe(1);
    expect(job?.startedAt).toBeInstanceOf(Date);
  });

  it('returns null when the queue is empty', async () => {
    expect(await claimNextJob()).toBeNull();
  });

  it('never hands the same job to two workers', async () => {
    // The property `FOR UPDATE SKIP LOCKED` exists to provide.
    await enqueue({ type: JOB_TYPES.websiteScan, workspaceId: workspace.id, payload: payload() });

    const claims = await Promise.all(Array.from({ length: 5 }, () => claimNextJob()));
    const claimed = claims.filter((job) => job !== null);

    expect(claimed).toHaveLength(1);
  });

  it('claims higher priority first', async () => {
    await enqueue({
      type: JOB_TYPES.websiteScan,
      workspaceId: workspace.id,
      payload: payload(),
      idempotencyKey: 'low',
      priority: 0,
    });
    await enqueue({
      type: JOB_TYPES.websiteScan,
      workspaceId: workspace.id,
      payload: payload(),
      idempotencyKey: 'high',
      priority: 10,
    });

    const job = await claimNextJob();
    expect(job?.idempotencyKey).toBe('high');
  });
});

describe('completion and failure', () => {
  it('records a successful result', async () => {
    const { job } = await enqueue({
      type: JOB_TYPES.websiteScan,
      workspaceId: workspace.id,
      payload: payload(),
    });
    await claimNextJob();
    await completeJob(job.id, { pagesFetched: 12 });

    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe('SUCCEEDED');
    expect(finished.result).toMatchObject({ pagesFetched: 12 });
  });

  it('retries a retryable failure with backoff', async () => {
    const { job } = await enqueue({
      type: JOB_TYPES.websiteScan,
      workspaceId: workspace.id,
      payload: payload(),
    });
    await claimNextJob();

    const { willRetry } = await failJob(job.id, { code: 'PROVIDER_TIMEOUT', message: 'slow' });
    expect(willRetry).toBe(true);

    const retried = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(retried.status).toBe('PENDING');
    expect(retried.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(retried.lastError).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });

  it('dead-letters after the attempt limit rather than retrying forever', async () => {
    const { job } = await enqueue({
      type: JOB_TYPES.websiteScan,
      workspaceId: workspace.id,
      payload: payload(),
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await prisma.job.update({
        where: { id: job.id },
        data: { status: 'PENDING', runAt: new Date() },
      });
      await claimNextJob();
      await failJob(job.id, { code: 'PROVIDER_ERROR', message: 'nope' });
    }

    const dead = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(dead.status).toBe('DEAD');
    expect(dead.attempts).toBe(3);
  });

  it('dead-letters immediately when the failure is not retryable', async () => {
    const { job } = await enqueue({
      type: JOB_TYPES.websiteScan,
      workspaceId: workspace.id,
      payload: payload(),
    });
    await claimNextJob();

    const { willRetry } = await failJob(job.id, {
      code: 'VALIDATION_ERROR',
      message: 'bad input',
      retryable: false,
    });

    expect(willRetry).toBe(false);
    const finished = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(finished.status).toBe('FAILED');
  });
});

describe('stalled jobs', () => {
  it('returns a job orphaned by a dead worker to the queue', async () => {
    const { job } = await enqueue({
      type: JOB_TYPES.websiteScan,
      workspaceId: workspace.id,
      payload: payload(),
    });
    await claimNextJob();

    // Pretend the worker died 20 minutes ago, past the 10-minute lease.
    await prisma.job.update({
      where: { id: job.id },
      data: { startedAt: new Date(Date.now() - 20 * 60 * 1000) },
    });

    expect(await reclaimStalledJobs()).toBe(1);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('PENDING');
  });

  it('leaves a job that is still within its lease alone', async () => {
    await enqueue({ type: JOB_TYPES.websiteScan, workspaceId: workspace.id, payload: payload() });
    await claimNextJob();

    expect(await reclaimStalledJobs()).toBe(0);
  });
});

describe('the worker', () => {
  it('runs a registered handler and records its result', async () => {
    registerJobHandler(JOB_TYPES.websiteScan, async () => ({ ok: true }));
    await enqueue({ type: JOB_TYPES.websiteScan, workspaceId: workspace.id, payload: payload() });

    const result = await runOneJob();
    expect(result).toMatchObject({ ran: true, outcome: 'succeeded' });
  });

  it('reports no work when the queue is empty', async () => {
    expect(await runOneJob()).toEqual({ ran: false });
  });

  it('retries when a handler throws a retryable error', async () => {
    registerJobHandler(JOB_TYPES.websiteScan, async () => {
      const { AppError } = await import('@/lib/errors');
      throw new AppError('PROVIDER_TIMEOUT', 'timed out');
    });
    await enqueue({ type: JOB_TYPES.websiteScan, workspaceId: workspace.id, payload: payload() });

    expect(await runOneJob()).toMatchObject({ outcome: 'retrying' });
  });

  it('dead-letters a job whose type has no handler', async () => {
    // A missing handler is a deployment error; retrying would waste attempts.
    await enqueue({ type: JOB_TYPES.websiteScan, workspaceId: workspace.id, payload: payload() });

    expect(await runOneJob()).toMatchObject({ outcome: 'dead' });
  });

  it('drains the queue up to a bound', async () => {
    registerJobHandler(JOB_TYPES.websiteScan, async () => ({ ok: true }));
    for (let index = 0; index < 4; index += 1) {
      await enqueue({
        type: JOB_TYPES.websiteScan,
        workspaceId: workspace.id,
        payload: payload(),
        idempotencyKey: `job-${index}`,
      });
    }

    expect(await drainQueue({ maxJobs: 10 })).toBe(4);
    expect((await queueDepth(workspace.id)).pending).toBe(0);
  });

  it('never exceeds its job bound', async () => {
    registerJobHandler(JOB_TYPES.websiteScan, async () => ({ ok: true }));
    for (let index = 0; index < 5; index += 1) {
      await enqueue({
        type: JOB_TYPES.websiteScan,
        workspaceId: workspace.id,
        payload: payload(),
        idempotencyKey: `bounded-${index}`,
      });
    }

    expect(await drainQueue({ maxJobs: 2 })).toBe(2);
  });
});

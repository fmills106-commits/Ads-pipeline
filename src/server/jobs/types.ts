import { z } from 'zod';

/**
 * The job type registry.
 *
 * Each job type declares a Zod schema for its payload. `enqueue` validates
 * against it, so a malformed payload is rejected at enqueue time rather than
 * discovered by a worker minutes later with no user around to tell.
 */

export const websiteScanPayload = z.object({
  scanRunId: z.string().uuid(),
  businessId: z.string().uuid(),
  requestedUrl: z.string().url(),
  /** A rescan compares against the previous completed scan. */
  isRescan: z.boolean().default(false),
  /**
   * Whether a person pressed the button, as opposed to the system deciding.
   *
   * The worker re-checks the pause — a pause that lands after a job is queued
   * must still stop it — and needs to know which kind of scan this is to apply
   * the same rule `startScan` did. Defaulted false so a payload written before
   * this field existed, or by a caller that does not set it, is treated as
   * automatic.
   */
  ownerRequested: z.boolean().default(false),
});

export const JOB_TYPES = {
  websiteScan: 'website.scan',
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

/** Payload schema per job type. */
export const JOB_PAYLOAD_SCHEMAS = {
  [JOB_TYPES.websiteScan]: websiteScanPayload,
} as const satisfies Record<JobType, z.ZodTypeAny>;

export type JobPayloads = {
  [JOB_TYPES.websiteScan]: z.infer<typeof websiteScanPayload>;
};

/**
 * How many times each type may be attempted, and how long a single attempt may
 * run before a supervisor should assume it died.
 *
 * A crawl is bounded by its own page and time limits; the lease here only
 * exists so a worker killed mid-job does not leave the row RUNNING forever.
 *
 * Five minutes, not ten: a crawl's own ceiling is four, so anything past five
 * is genuinely dead rather than slow. The difference matters on a serverless
 * host, where an invocation killed at its function timeout would otherwise
 * strand the owner's scan for the rest of the lease with nothing happening
 * and no explanation.
 */
export const JOB_LIMITS: Record<JobType, { maxAttempts: number; leaseMs: number }> = {
  [JOB_TYPES.websiteScan]: { maxAttempts: 3, leaseMs: 5 * 60 * 1000 },
};

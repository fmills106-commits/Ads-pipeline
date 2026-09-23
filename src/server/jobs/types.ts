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
 */
export const JOB_LIMITS: Record<JobType, { maxAttempts: number; leaseMs: number }> = {
  [JOB_TYPES.websiteScan]: { maxAttempts: 3, leaseMs: 10 * 60 * 1000 },
};

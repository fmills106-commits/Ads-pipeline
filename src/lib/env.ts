import { z } from 'zod';

/**
 * Centralised, schema-validated environment configuration.
 *
 * Two rules make this file worth its existence:
 *  1. Nothing else in the codebase reads `process.env` directly. Import `env`.
 *  2. Validation happens once, eagerly, and a bad value is a startup failure —
 *     not a `undefined` that surfaces three layers deep at 2am.
 */

const nonEmpty = z.string().min(1);

/** A base64-encoded key of exactly `bytes` decoded length. */
const base64Key = (bytes: number) =>
  z.string().refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === bytes;
      } catch {
        return false;
      }
    },
    { message: `must be base64 encoding exactly ${bytes} bytes` },
  );

/** Accepts "true"/"1"/"yes" (case-insensitive) as true; anything else false. */
const boolish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue;
      return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
    });

const intish = (defaultValue: number, options: { allowZero?: boolean } = {}) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? defaultValue : Number(value)))
    .pipe(options.allowZero ? z.number().int().nonnegative() : z.number().int().positive());

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const envSchema = z
  .object({
    // --- Phase 1: core runtime -------------------------------------------
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_URL: z.string().url().default('http://localhost:3000'),
    DATABASE_URL: nonEmpty,
    AUTH_SECRET: z.string().min(32, 'AUTH_SECRET must be at least 32 characters'),
    ENCRYPTION_KEY: base64Key(32),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),

    // --- Zero-cost operation ---------------------------------------------
    // The master switch. On (the default), every capability resolves to a
    // local or mock implementation, no paid provider can be reached, and the
    // whole advertising pipeline runs end to end for $0. Turning it off is an
    // explicit, deliberate act — the application never does it on your behalf.
    ZERO_COST_MODE: boolish(true),

    // --- Phase 2: website scanner ----------------------------------------
    CRAWLER_USER_AGENT: z.string().default('AdsPipelineBot/0.1'),
    CRAWLER_MIN_DELAY_MS: intish(1_000),
    CRAWLER_MAX_PAGES: intish(200),
    CRAWLER_TIMEOUT_MS: intish(15_000),
    CRAWLER_MAX_BYTES: intish(5_000_000),

    // --- Optional external providers -------------------------------------
    // Every one of these is optional. Unset means "not configured", which
    // means the capability resolves to its local/free implementation. None of
    // them is ever required to run, develop, or test the application.
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
    IMAGE_PROVIDER_API_KEY: z.string().optional(),
    STORAGE_S3_BUCKET: z.string().optional(),
    STORAGE_S3_REGION: z.string().optional(),
    STORAGE_S3_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_S3_SECRET_ACCESS_KEY: z.string().optional(),
    META_APP_ID: z.string().optional(),
    META_APP_SECRET: z.string().optional(),
    META_API_VERSION: z.string().default('v21.0'),
    META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

    /// Local filesystem root for the free storage provider.
    STORAGE_LOCAL_PATH: z.string().default('.storage'),

    // --- Infrastructure cost ceilings -------------------------------------
    // What the platform may spend on AI, image generation and other metered
    // APIs. Distinct from advertising spend below. Zero is a legal value and
    // is what ZERO_COST_MODE enforces regardless of what is configured here.
    MAX_DAILY_PROVIDER_COST_CENTS: intish(0, { allowZero: true }),
    MAX_MONTHLY_PROVIDER_COST_CENTS: intish(0, { allowZero: true }),
    /// Ceiling for any single provider call. Stops one runaway request.
    MAX_SINGLE_CALL_COST_CENTS: intish(50, { allowZero: true }),

    // --- Advertising spending ceilings ------------------------------------
    // Money spent on ads, on the advertising platform. Always intersected
    // with each business's own stated budget; the lower of the two wins.
    MAX_DAILY_BUDGET_CENTS: intish(2_000),
    MAX_CAMPAIGN_BUDGET_CENTS: intish(10_000),
    BUDGET_APPROVAL_THRESHOLD_CENTS: intish(5_000),

    /// Set by Next.js itself. Read, never configured by us — see below.
    NEXT_PHASE: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    // Partial S3 configuration is worse than none: it looks configured and
    // fails at the first upload. Either give it everything or leave it unset
    // and use the local filesystem, which costs nothing and always works.
    const s3Fields = [
      value.STORAGE_S3_BUCKET,
      value.STORAGE_S3_REGION,
      value.STORAGE_S3_ACCESS_KEY_ID,
      value.STORAGE_S3_SECRET_ACCESS_KEY,
    ];
    if (s3Fields.some(Boolean) && !s3Fields.every(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_S3_BUCKET'],
        message:
          'S3 storage is partially configured. Set bucket, region, key id and secret together, or unset all four to use free local storage.',
      });
    }
    if (Boolean(value.META_APP_ID) !== Boolean(value.META_APP_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['META_APP_SECRET'],
        message: 'META_APP_ID and META_APP_SECRET must be set together, or neither.',
      });
    }
    if (value.MAX_DAILY_BUDGET_CENTS > value.MAX_CAMPAIGN_BUDGET_CENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAX_DAILY_BUDGET_CENTS'],
        message: 'cannot exceed MAX_CAMPAIGN_BUDGET_CENTS',
      });
    }
    // Zero means zero, not "unlimited" — so a daily allowance larger than the
    // monthly one is always a contradiction, including 100 daily against 0
    // monthly. The default is 0/0: nothing paid may run until you say so.
    if (value.MAX_DAILY_PROVIDER_COST_CENTS > value.MAX_MONTHLY_PROVIDER_COST_CENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAX_DAILY_PROVIDER_COST_CENTS'],
        message: 'cannot exceed MAX_MONTHLY_PROVIDER_COST_CENTS (0 means no paid spend at all)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Parses a raw environment record. Exported separately from the cached `env`
 * singleton so tests can exercise the schema without mutating `process.env`.
 *
 * @throws {Error} with every validation failure listed, when parsing fails.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

let cached: Env | undefined;

/** The validated environment. Parsed once, on first access. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test-only: drop the memoised value so the next `getEnv()` re-parses. */
export function resetEnvCache(): void {
  cached = undefined;
}

export const isProduction = (): boolean => getEnv().NODE_ENV === 'production';
export const isTest = (): boolean => getEnv().NODE_ENV === 'test';

/**
 * True when the application is running entirely on local and mock providers,
 * with no possibility of spending money on an external service.
 */
export const isZeroCostMode = (): boolean => getEnv().ZERO_COST_MODE;

export interface CostCeilings {
  dailyCents: number;
  monthlyCents: number;
  singleCallCents: number;
}

/**
 * The cost ceilings actually in force.
 *
 * `ZERO_COST_MODE` wins over anything configured: it collapses every ceiling
 * to zero rather than trusting each call site to remember to check the mode.
 * One function decides, so "is this allowed to cost money?" has exactly one
 * answer everywhere in the codebase.
 */
export function costCeilings(env: Env = getEnv()): CostCeilings {
  if (env.ZERO_COST_MODE) {
    return { dailyCents: 0, monthlyCents: 0, singleCallCents: 0 };
  }
  return {
    dailyCents: env.MAX_DAILY_PROVIDER_COST_CENTS,
    monthlyCents: env.MAX_MONTHLY_PROVIDER_COST_CENTS,
    singleCallCents: env.MAX_SINGLE_CALL_COST_CENTS,
  };
}

/**
 * Whether credentials exist for each optional external service.
 *
 * Absence is not an error anywhere — it means the capability resolves to its
 * local, free implementation. This is only ever consulted to decide what
 * *could* be offered, never to decide what runs.
 */
export function externalCredentials(env: Env = getEnv()): {
  anthropic: boolean;
  imageGeneration: boolean;
  s3: boolean;
  meta: boolean;
} {
  return {
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
    imageGeneration: Boolean(env.IMAGE_PROVIDER_API_KEY),
    s3: Boolean(env.STORAGE_S3_BUCKET && env.STORAGE_S3_ACCESS_KEY_ID),
    meta: Boolean(env.META_APP_ID && env.META_APP_SECRET),
  };
}

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

const intish = (defaultValue: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? defaultValue : Number(value)))
    .pipe(z.number().int().positive());

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
    MOCK_MODE: boolish(true),

    // --- Phase 2: website scanner ----------------------------------------
    CRAWLER_USER_AGENT: z.string().default('AdsPipelineBot/0.1'),
    CRAWLER_MIN_DELAY_MS: intish(1_000),
    CRAWLER_MAX_PAGES: intish(200),
    CRAWLER_TIMEOUT_MS: intish(15_000),
    CRAWLER_MAX_BYTES: intish(5_000_000),

    // --- Phase 3: AI provider --------------------------------------------
    AI_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),

    // --- Phase 4: images + storage ---------------------------------------
    IMAGE_PROVIDER: z.enum(['mock']).default('mock'),
    IMAGE_PROVIDER_API_KEY: z.string().optional(),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('.storage'),
    STORAGE_S3_BUCKET: z.string().optional(),
    STORAGE_S3_REGION: z.string().optional(),
    STORAGE_S3_ACCESS_KEY_ID: z.string().optional(),
    STORAGE_S3_SECRET_ACCESS_KEY: z.string().optional(),

    // --- Phase 6: Meta ----------------------------------------------------
    META_APP_ID: z.string().optional(),
    META_APP_SECRET: z.string().optional(),
    META_API_VERSION: z.string().default('v21.0'),
    META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

    // --- Phase 5/10: platform-wide spending ceilings ----------------------
    MAX_DAILY_BUDGET_CENTS: intish(2_000),
    MAX_CAMPAIGN_BUDGET_CENTS: intish(10_000),
    BUDGET_APPROVAL_THRESHOLD_CENTS: intish(5_000),

    /// Set by Next.js itself. Read, never configured by us — see below.
    NEXT_PHASE: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    // Live providers are only meaningful with credentials, and only outside
    // mock mode. Catching the mismatch here beats a 401 mid-campaign.
    if (!value.MOCK_MODE && value.AI_PROVIDER === 'anthropic' && !value.ANTHROPIC_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ANTHROPIC_API_KEY'],
        message: 'required when AI_PROVIDER=anthropic and MOCK_MODE is off',
      });
    }
    if (!value.MOCK_MODE && value.STORAGE_DRIVER === 's3' && !value.STORAGE_S3_BUCKET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_S3_BUCKET'],
        message: 'required when STORAGE_DRIVER=s3',
      });
    }
    // Serving real traffic with fake providers would show merchants invented
    // campaigns and invented metrics. `next build` also runs with
    // NODE_ENV=production while evaluating route modules, though, and a
    // developer building locally is not serving anything — so the build phase
    // is exempt. The guard still holds for every request at runtime.
    if (
      value.NODE_ENV === 'production' &&
      value.MOCK_MODE &&
      value.NEXT_PHASE !== 'phase-production-build'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MOCK_MODE'],
        message: 'must be disabled in production',
      });
    }
    if (value.MAX_DAILY_BUDGET_CENTS > value.MAX_CAMPAIGN_BUDGET_CENTS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAX_DAILY_BUDGET_CENTS'],
        message: 'cannot exceed MAX_CAMPAIGN_BUDGET_CENTS',
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
export const isMockMode = (): boolean => getEnv().MOCK_MODE;

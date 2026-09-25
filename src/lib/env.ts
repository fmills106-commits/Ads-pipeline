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

    // --- Public deployment ------------------------------------------------
    /**
     * Which reverse proxy sits in front of this deployment, if any.
     *
     * This decides which header the real client IP is read from, and it is
     * configuration rather than detection on purpose: `X-Forwarded-For`
     * arrives from the open internet and anyone can set it, so trusting it
     * unconditionally would let one caller defeat per-IP rate limiting by
     * rotating a header. `none` (the default) reads no proxy header at all.
     */
    TRUSTED_PROXY: z.enum(['none', 'cloudflare', 'vercel']).default('none'),

    /**
     * Shared secret authorising the scheduled worker endpoint.
     *
     * Required in production: without a worker nothing in the queue ever
     * runs, and an unauthenticated drain endpoint is a free denial-of-service
     * against every tenant's crawl budget. Generate with
     * `openssl rand -base64 32`.
     */
    CRON_SECRET: z.string().min(24).optional(),

    /**
     * How long one worker invocation may spend before returning.
     *
     * The default suits a process that owns its own lifetime. On a serverless
     * host it must be set below the platform's function timeout, or the
     * invocation is killed mid-crawl and the work is repeated rather than
     * finished. A crawl cut short by this budget reports PARTIAL with the
     * pages it did read — accurate, just incomplete — instead of failing.
     */
    WORKER_MAX_RUN_MS: intish(4 * 60 * 1000),

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

    // --- Set by the hosting platform -------------------------------------
    // Read, never configured by us. `applyPlatformDefaults` uses them to fill
    // in what the platform already knows, and the refinement below uses
    // VERCEL_ENV to catch a deployment running in the wrong mode.
    VERCEL: z.string().optional(),
    VERCEL_ENV: z.string().optional(),
    VERCEL_URL: z.string().optional(),
    VERCEL_PROJECT_PRODUCTION_URL: z.string().optional(),
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

    /*
     * --- Production-only requirements -------------------------------------
     *
     * Fine to omit locally, dangerous to omit once a domain points at the
     * deployment, so they fail at boot rather than at 3am.
     *
     * Skipped during `next build`, which sets NODE_ENV=production while
     * compiling: a build reads pages, it does not serve requests, and
     * demanding a real session secret to produce a bundle would mean nobody
     * could run `npm run build` without production credentials to hand.
     * Vercel and the Dockerfile both build before these values exist.
     */
    const isBuild = value.NEXT_PHASE === 'phase-production-build';

    /*
     * A production deployment running with NODE_ENV=development is refused
     * rather than corrected.
     *
     * This is the one misconfiguration here with no symptom: every
     * production-only check below is skipped, and session cookies lose their
     * `secure` flag, so they travel over plain HTTP if anything ever
     * downgrades the connection. It is easy to arrive at by accident —
     * importing `.env.example` into a host picks up `NODE_ENV=development`
     * along with everything else.
     *
     * Silently forcing it to production would hide a real mistake in
     * somebody's project settings. Refusing says what is wrong, once.
     */
    if (value.VERCEL_ENV === 'production' && value.NODE_ENV !== 'production' && !isBuild) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NODE_ENV'],
        message:
          'must be "production" on a production deployment. Every safety check below is skipped otherwise, and session cookies are not marked secure. Remove NODE_ENV from your project settings, or set it to production.',
      });
    }

    if (value.NODE_ENV === 'production' && !isBuild) {
      if (value.APP_URL.startsWith('http://')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['APP_URL'],
          message:
            'must be https:// in production — session cookies are only marked secure when it is',
        });
      }
      if (!value.CRON_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CRON_SECRET'],
          message:
            'is required in production, or queued scans never run. Generate one with `openssl rand -base64 32`',
        });
      }
      if (value.LOG_FORMAT === 'pretty') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['LOG_FORMAT'],
          message: 'must be json in production so logs stay machine-readable',
        });
      }
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
  const result = envSchema.safeParse(applyPlatformDefaults(source));
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

/**
 * Fills in what the hosting platform already knows.
 *
 * Four of the values a deployment needs are not really decisions — they are
 * facts about where the code is running, which the platform states in its own
 * build environment. Asking an operator to retype them is asking them to get
 * them wrong: setting `TRUSTED_PROXY=none` on Vercel silently disables per-IP
 * rate limiting, and an `APP_URL` typo without `https://` stops the app
 * booting.
 *
 * Note what is and is not inferred. The *platform* is inferred, from variables
 * the platform sets at build time and a request cannot influence. Which header
 * to believe for a client's address is still a configured decision — it just
 * gets a correct default once the platform is known. That is a different thing
 * from reading `X-Forwarded-For` and hoping, which is what this exists to
 * avoid.
 *
 * Anything explicitly set always wins, so this can never override a
 * deliberate choice.
 */
function applyPlatformDefaults(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Set by Vercel in every build and runtime; absent everywhere else.
  if (source['VERCEL'] !== '1') return source;

  const filled: NodeJS.ProcessEnv = { ...source };
  const setIfAbsent = (key: string, value: string | undefined): void => {
    if (value && !filled[key]) filled[key] = value;
  };

  /*
   * A preview deployment has its own hostname, so pointing it at the
   * production URL would make session cookies and OAuth redirects target the
   * wrong site. `VERCEL_URL` is this deployment; the other is the stable one.
   */
  const host =
    source['VERCEL_ENV'] === 'production'
      ? source['VERCEL_PROJECT_PRODUCTION_URL']
      : source['VERCEL_URL'];
  setIfAbsent('APP_URL', host ? `https://${host}` : undefined);

  // Vercel terminates TLS and sets X-Real-IP itself, overwriting any the
  // caller supplied.
  setIfAbsent('TRUSTED_PROXY', 'vercel');

  // Serverless logs are collected and indexed; pretty-printing only makes
  // them harder to search.
  setIfAbsent('LOG_FORMAT', 'json');

  /*
   * Below the platform's function timeout, so a crawl stops itself and
   * reports what it read rather than being killed mid-page and repeating the
   * whole attempt. 50s fits inside Hobby's ceiling; a project on a plan with
   * longer functions can raise it explicitly.
   */
  setIfAbsent('WORKER_MAX_RUN_MS', '50000');

  return filled;
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

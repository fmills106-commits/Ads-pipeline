import { describe, expect, it } from 'vitest';
import { costCeilings, externalCredentials, parseEnv } from '@/lib/env';

/**
 * The environment is where the zero-cost guarantee is anchored, so these tests
 * are mostly about one question: can a configuration slip cause a bill?
 */

const valid = {
  NODE_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AUTH_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
} satisfies NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('needs only four values plus a database — no API keys of any kind', () => {
    const env = parseEnv(valid);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.CRAWLER_MAX_PAGES).toBe(200);
    expect(env.MAX_DAILY_BUDGET_CENTS).toBe(2000);
  });

  it('rejects a short AUTH_SECRET', () => {
    expect(() => parseEnv({ ...valid, AUTH_SECRET: 'too-short' })).toThrow(/AUTH_SECRET/);
  });

  it('rejects an ENCRYPTION_KEY that is not exactly 32 bytes', () => {
    const sixteenBytes = Buffer.alloc(16, 1).toString('base64');
    expect(() => parseEnv({ ...valid, ENCRYPTION_KEY: sixteenBytes })).toThrow(/exactly 32 bytes/);
  });

  it('rejects a malformed APP_URL', () => {
    expect(() => parseEnv({ ...valid, APP_URL: 'not-a-url' })).toThrow(/APP_URL/);
  });

  it('reports every failure at once rather than one at a time', () => {
    let message = '';
    try {
      parseEnv({ ...valid, AUTH_SECRET: 'short', APP_URL: 'nope' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/AUTH_SECRET/);
    expect(message).toMatch(/APP_URL/);
  });
});

describe('ZERO_COST_MODE', () => {
  it('defaults to on when unset — a fresh checkout cannot spend money', () => {
    expect(parseEnv(valid).ZERO_COST_MODE).toBe(true);
  });

  it('parses the boolean spellings people actually write', () => {
    expect(parseEnv({ ...valid, ZERO_COST_MODE: 'yes' }).ZERO_COST_MODE).toBe(true);
    expect(parseEnv({ ...valid, ZERO_COST_MODE: '1' }).ZERO_COST_MODE).toBe(true);
    expect(parseEnv({ ...valid, ZERO_COST_MODE: 'false' }).ZERO_COST_MODE).toBe(false);
    expect(parseEnv({ ...valid, ZERO_COST_MODE: 'off' }).ZERO_COST_MODE).toBe(false);
  });

  it('is allowed in production — simulated advertising is a legitimate deployment', () => {
    // Earlier this was refused. It should not be: a self-hosted install running
    // entirely on free providers is exactly what this product is meant to allow.
    // The other values here are what *any* production deployment needs (see
    // "production requirements" below); zero-cost mode adds no requirements
    // of its own, which is the point being asserted.
    expect(() =>
      parseEnv({
        ...valid,
        NODE_ENV: 'production',
        APP_URL: 'https://ads.example.com',
        CRON_SECRET: 'c'.repeat(32),
        ZERO_COST_MODE: 'true',
      }),
    ).not.toThrow();
  });
});

describe('costCeilings', () => {
  it('is zero by default, even with zero-cost mode off', () => {
    // Turning off zero-cost mode alone must not permit any spending — the
    // ceilings are a second, independent switch.
    const env = parseEnv({ ...valid, ZERO_COST_MODE: 'false' });
    expect(costCeilings(env)).toEqual({ dailyCents: 0, monthlyCents: 0, singleCallCents: 50 });
  });

  it('collapses every configured ceiling to zero while zero-cost mode is on', () => {
    const env = parseEnv({
      ...valid,
      ZERO_COST_MODE: 'true',
      MAX_DAILY_PROVIDER_COST_CENTS: '500',
      MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      MAX_SINGLE_CALL_COST_CENTS: '100',
    });
    expect(costCeilings(env)).toEqual({ dailyCents: 0, monthlyCents: 0, singleCallCents: 0 });
  });

  it('honours configured ceilings once zero-cost mode is off', () => {
    const env = parseEnv({
      ...valid,
      ZERO_COST_MODE: 'false',
      MAX_DAILY_PROVIDER_COST_CENTS: '500',
      MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      MAX_SINGLE_CALL_COST_CENTS: '100',
    });
    expect(costCeilings(env)).toEqual({
      dailyCents: 500,
      monthlyCents: 5000,
      singleCallCents: 100,
    });
  });

  it('rejects a daily ceiling above the monthly one — zero means zero', () => {
    expect(() =>
      parseEnv({
        ...valid,
        MAX_DAILY_PROVIDER_COST_CENTS: '100',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '0',
      }),
    ).toThrow(/cannot exceed MAX_MONTHLY_PROVIDER_COST_CENTS/);
  });
});

describe('optional external credentials', () => {
  it('treats every external service as absent by default', () => {
    expect(externalCredentials(parseEnv(valid))).toEqual({
      anthropic: false,
      imageGeneration: false,
      s3: false,
      meta: false,
    });
  });

  it('does not require any credential to parse successfully', () => {
    // The whole point: no API key is ever a required variable.
    expect(() => parseEnv(valid)).not.toThrow();
  });

  it('reports a credential as present once configured', () => {
    const env = parseEnv({ ...valid, ANTHROPIC_API_KEY: 'sk-ant-test' });
    expect(externalCredentials(env).anthropic).toBe(true);
  });

  it('rejects partially configured S3 rather than failing at first upload', () => {
    expect(() => parseEnv({ ...valid, STORAGE_S3_BUCKET: 'my-bucket' })).toThrow(
      /partially configured/,
    );
  });

  it('accepts fully configured S3', () => {
    expect(() =>
      parseEnv({
        ...valid,
        STORAGE_S3_BUCKET: 'b',
        STORAGE_S3_REGION: 'r',
        STORAGE_S3_ACCESS_KEY_ID: 'k',
        STORAGE_S3_SECRET_ACCESS_KEY: 's',
      }),
    ).not.toThrow();
  });

  it('rejects a Meta app id without its secret', () => {
    expect(() => parseEnv({ ...valid, META_APP_ID: '123' })).toThrow(/must be set together/);
  });
});

describe('advertising ceilings', () => {
  it('rejects a daily cap above the campaign cap', () => {
    expect(() =>
      parseEnv({
        ...valid,
        MAX_DAILY_BUDGET_CENTS: '50000',
        MAX_CAMPAIGN_BUDGET_CENTS: '10000',
      }),
    ).toThrow(/cannot exceed MAX_CAMPAIGN_BUDGET_CENTS/);
  });
});

/**
 * Configuration that is optional locally and load-bearing in production.
 *
 * Each of these has a failure mode that is silent and expensive to discover:
 * cookies sent over plain HTTP, a queue nothing ever drains, logs nothing can
 * parse. Boot is the only good place to catch them.
 */
describe('production requirements', () => {
  const production = {
    ...valid,
    NODE_ENV: 'production',
    APP_URL: 'https://ads.example.com',
    CRON_SECRET: 'c'.repeat(32),
    LOG_FORMAT: 'json',
  } satisfies NodeJS.ProcessEnv;

  it('accepts a complete production configuration', () => {
    expect(() => parseEnv(production)).not.toThrow();
  });

  it('refuses plain HTTP, because session cookies would not be secure', () => {
    expect(() => parseEnv({ ...production, APP_URL: 'http://ads.example.com' })).toThrow(
      /must be https/,
    );
  });

  it('refuses a missing cron secret, because nothing would drain the queue', () => {
    const { CRON_SECRET: _omitted, ...withoutSecret } = production;
    expect(() => parseEnv(withoutSecret)).toThrow(/CRON_SECRET/);
  });

  it('refuses a cron secret too short to be worth having', () => {
    expect(() => parseEnv({ ...production, CRON_SECRET: 'short' })).toThrow();
  });

  it('refuses pretty logs, which no log aggregator can read', () => {
    expect(() => parseEnv({ ...production, LOG_FORMAT: 'pretty' })).toThrow(/must be json/);
  });

  it('still allows all of it to be absent outside production', () => {
    // The point of the whole exercise: cloning the repo and running it must
    // not require any of this.
    expect(() => parseEnv(valid)).not.toThrow();
  });

  it('skips the checks during a production build', () => {
    // `next build` sets NODE_ENV=production while compiling. A build reads
    // pages rather than serving them, so requiring a real session secret to
    // produce a bundle would mean nobody could build without production
    // credentials — including Vercel and the Dockerfile, which build first.
    expect(() =>
      parseEnv({ ...valid, NODE_ENV: 'production', NEXT_PHASE: 'phase-production-build' }),
    ).not.toThrow();
  });
});

describe('proxy trust', () => {
  it('trusts nothing by default', () => {
    expect(parseEnv(valid).TRUSTED_PROXY).toBe('none');
  });

  it('rejects a proxy name it has no header mapping for', () => {
    // Silently falling back to "none" would look configured and do nothing.
    expect(() => parseEnv({ ...valid, TRUSTED_PROXY: 'nginx' })).toThrow();
  });
});

/**
 * What the hosting platform already knows.
 *
 * Four production values are facts about where the code runs rather than
 * decisions, and every one of them has a bad failure mode when retyped by
 * hand: `TRUSTED_PROXY=none` on Vercel silently disables per-IP rate
 * limiting, and an `APP_URL` without `https://` stops the app booting. These
 * tests pin what is inferred, what is not, and that an explicit value always
 * wins.
 */
describe('platform defaults', () => {
  const onVercel = {
    ...valid,
    NODE_ENV: 'production',
    VERCEL: '1',
    VERCEL_ENV: 'production',
    VERCEL_PROJECT_PRODUCTION_URL: 'ads.example.com',
    CRON_SECRET: 'c'.repeat(32),
  } satisfies NodeJS.ProcessEnv;

  it('infers nothing when not on a known platform', () => {
    // A VPS or a container gets no magic: it configures itself.
    const env = parseEnv(valid);
    expect(env.TRUSTED_PROXY).toBe('none');
    expect(env.APP_URL).toBe('http://localhost:3000');
  });

  it('derives the URL, proxy, log format and worker budget on Vercel', () => {
    const { APP_URL: _url, ...withoutUrl } = onVercel;
    const env = parseEnv(withoutUrl);

    expect(env.APP_URL).toBe('https://ads.example.com');
    expect(env.TRUSTED_PROXY).toBe('vercel');
    expect(env.LOG_FORMAT).toBe('json');
    // Below Hobby's function timeout, so a crawl stops itself rather than
    // being killed mid-page and repeating the whole attempt.
    expect(env.WORKER_MAX_RUN_MS).toBeLessThan(60_000);
  });

  it('uses the deployment’s own hostname for a preview', () => {
    // Pointing a preview at the production URL would send its session
    // cookies and OAuth redirects to the wrong site.
    const { APP_URL: _url, ...rest } = onVercel;
    const env = parseEnv({
      ...rest,
      VERCEL_ENV: 'preview',
      VERCEL_URL: 'ads-pipeline-git-branch.vercel.app',
    });

    expect(env.APP_URL).toBe('https://ads-pipeline-git-branch.vercel.app');
  });

  it('never overrides a value that was set explicitly', () => {
    const env = parseEnv({
      ...onVercel,
      APP_URL: 'https://custom.example.com',
      TRUSTED_PROXY: 'cloudflare',
      WORKER_MAX_RUN_MS: '120000',
    });

    // Cloudflare in front of Vercel is a real setup, and inference must not
    // fight a deliberate choice.
    expect(env.APP_URL).toBe('https://custom.example.com');
    expect(env.TRUSTED_PROXY).toBe('cloudflare');
    expect(env.WORKER_MAX_RUN_MS).toBe(120_000);
  });

  it('refuses a production deployment running in development mode', () => {
    // The one misconfiguration with no symptom: safety checks skipped and
    // session cookies no longer marked secure. Reachable by importing
    // .env.example into a host, which carries NODE_ENV=development.
    expect(() => parseEnv({ ...onVercel, NODE_ENV: 'development' })).toThrow(/NODE_ENV/);
  });

  it('still allows a preview deployment to run in development mode', () => {
    expect(() =>
      parseEnv({ ...onVercel, VERCEL_ENV: 'preview', NODE_ENV: 'development' }),
    ).not.toThrow();
  });
});

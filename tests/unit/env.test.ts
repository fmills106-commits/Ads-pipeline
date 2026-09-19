import { describe, expect, it } from 'vitest';
import { parseEnv } from '@/lib/env';

const valid = {
  NODE_ENV: 'development',
  APP_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  AUTH_SECRET: 'x'.repeat(32),
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  MOCK_MODE: 'true',
} satisfies NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.AI_PROVIDER).toBe('mock');
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

  it('parses boolean-ish MOCK_MODE values', () => {
    expect(parseEnv({ ...valid, MOCK_MODE: 'yes' }).MOCK_MODE).toBe(true);
    expect(parseEnv({ ...valid, MOCK_MODE: '1' }).MOCK_MODE).toBe(true);
    expect(parseEnv({ ...valid, MOCK_MODE: 'false' }).MOCK_MODE).toBe(false);
    expect(parseEnv({ ...valid, MOCK_MODE: 'off' }).MOCK_MODE).toBe(false);
  });

  it('defaults MOCK_MODE to true when unset — no accidental live calls', () => {
    const { MOCK_MODE: _omitted, ...withoutMockMode } = valid;
    expect(parseEnv(withoutMockMode).MOCK_MODE).toBe(true);
  });

  it('refuses mock mode in production', () => {
    expect(() => parseEnv({ ...valid, NODE_ENV: 'production', MOCK_MODE: 'true' })).toThrow(
      /must be disabled in production/,
    );
  });

  it('exempts the Next.js build phase, which compiles with NODE_ENV=production', () => {
    // Building locally is not serving traffic; the guard still applies at runtime.
    expect(() =>
      parseEnv({
        ...valid,
        NODE_ENV: 'production',
        MOCK_MODE: 'true',
        NEXT_PHASE: 'phase-production-build',
      }),
    ).not.toThrow();
  });

  it('still refuses mock mode in production under any other NEXT_PHASE', () => {
    expect(() =>
      parseEnv({
        ...valid,
        NODE_ENV: 'production',
        MOCK_MODE: 'true',
        NEXT_PHASE: 'phase-production-server',
      }),
    ).toThrow(/must be disabled in production/);
  });

  it('requires an Anthropic key when the live AI provider is selected', () => {
    expect(() => parseEnv({ ...valid, MOCK_MODE: 'false', AI_PROVIDER: 'anthropic' })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('allows the anthropic provider to be configured while mock mode is on', () => {
    expect(() => parseEnv({ ...valid, MOCK_MODE: 'true', AI_PROVIDER: 'anthropic' })).not.toThrow();
  });

  it('rejects a daily cap above the campaign cap', () => {
    expect(() =>
      parseEnv({
        ...valid,
        MAX_DAILY_BUDGET_CENTS: '50000',
        MAX_CAMPAIGN_BUDGET_CENTS: '10000',
      }),
    ).toThrow(/cannot exceed MAX_CAMPAIGN_BUDGET_CENTS/);
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

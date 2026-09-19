import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { beforeAll, afterAll } from 'vitest';

/**
 * Database-test setup.
 *
 * Loads `.env.test`, applies migrations once per run, and hands each test file
 * a clean schema. These tests are the only place tenant isolation can actually
 * be proven, so they run against real PostgreSQL rather than a mock.
 */

const envPath = resolve(process.cwd(), '.env.test');
if (existsSync(envPath)) loadDotenv({ path: envPath, override: true });

(process.env as Record<string, string | undefined>).NODE_ENV = 'test';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'DATABASE_URL is not set. Database tests need a reachable PostgreSQL; see .env.test.',
  );
}

// Guard against ever pointing these at something that is not a test database:
// the suite truncates every table between files.
if (!/test/i.test(databaseUrl)) {
  throw new Error(
    `Refusing to run destructive database tests against "${redactUrl(databaseUrl)}" — ` +
      'the database name must contain "test".',
  );
}

beforeAll(() => {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}, 120_000);

afterAll(async () => {
  const { prisma } = await import('@/lib/db');
  await prisma.$disconnect();
});

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '';
    parsed.username = '';
    return parsed.toString();
  } catch {
    return '<unparseable>';
  }
}

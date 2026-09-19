/**
 * Unit-test setup.
 *
 * Provides the minimum valid environment so modules that call `getEnv()` work,
 * without requiring a database or any credentials. Nothing here touches the
 * network or the filesystem.
 */
// Next.js types `NODE_ENV` as read-only; in a test setup file assigning it is
// the point, so the record is widened once here rather than cast per line.
const env = process.env as Record<string, string | undefined>;

env.NODE_ENV ??= 'test';
env.APP_URL ??= 'http://localhost:3000';
env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unused';
env.AUTH_SECRET ??= 'unit-test-auth-secret-at-least-32-chars-long';
env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
env.LOG_LEVEL ??= 'error';
env.LOG_FORMAT ??= 'json';
env.ZERO_COST_MODE ??= 'true';

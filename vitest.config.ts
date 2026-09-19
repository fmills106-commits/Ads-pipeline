import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Two projects:
 *  - `unit` runs everywhere, with no external services. Always safe in CI.
 *  - `db`   requires a reachable PostgreSQL at DATABASE_URL, configured by
 *           `.env.test`, and applies migrations before the suite runs.
 *
 * The `@/…` alias is declared here rather than via vite-tsconfig-paths: that
 * plugin is ESM-only and this config is loaded as CJS, and one alias is not
 * worth a dependency.
 */
const srcAlias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
};

export default defineConfig({
  resolve: { alias: srcAlias },
  test: {
    globals: false,
    projects: [
      {
        resolve: { alias: srcAlias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
          setupFiles: ['tests/setup/unit.ts'],
        },
      },
      {
        resolve: { alias: srcAlias },
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          setupFiles: ['tests/setup/db.ts'],
          // Tenant-isolation tests share one database and truncate between
          // files, so they must not run in parallel with each other.
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});

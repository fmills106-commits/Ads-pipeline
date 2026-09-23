/**
 * The background worker.
 *
 *   npm run worker
 *
 * Production runs this as a separate process. A single-process development
 * server can get by without it — the scan API kicks the queue in-process —
 * but that is best-effort and a real deployment should run this.
 */
import { config } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env');
if (existsSync(envPath)) config({ path: envPath });

async function main(): Promise<void> {
  const { logger } = await import('../src/lib/logger');
  const { registerScannerJobs } = await import('../src/server/scanner/job');
  const { runWorkerLoop } = await import('../src/server/jobs/worker');

  registerScannerJobs();

  const controller = new AbortController();
  const stop = (signal: string) => {
    logger().info('Worker shutting down', { signal });
    controller.abort();
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  await runWorkerLoop({ signal: controller.signal });

  const { prisma } = await import('../src/lib/db');
  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error('Worker failed to start:', error);
  process.exitCode = 1;
});

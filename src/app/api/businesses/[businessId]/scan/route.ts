import { z } from 'zod';
import { validationError } from '@/lib/errors';
import { route } from '@/server/api/handler';
import { RATE_LIMITS } from '@/server/api/rate-limit';
import { getScanStatus, startScan } from '@/server/scanner/service';
import { registerScannerJobs } from '@/server/scanner/job';
import { kickQueue } from '@/server/jobs/worker';
import { JOB_TYPES } from '@/server/jobs/types';
import { requireBusinessContext } from '@/server/tenancy/context';

// Handlers must be registered in whichever process runs the job. Importing
// here means a single-process development server can execute scans without a
// separate worker; `npm run worker` registers them the same way.
registerScannerJobs();

const startSchema = z.object({
  /** Optional override; defaults to the business's configured website. */
  url: z.string().url().max(2048).optional(),
});

/** POST /api/businesses/:businessId/scan — queue a scan. */
export const POST = route(
  { schema: startSchema, rateLimit: RATE_LIMITS.scan },
  async ({ body, params, user }) => {
    const businessId = params.businessId;
    if (typeof businessId !== 'string') throw validationError('businessId is required');

    const context = await requireBusinessContext(user, businessId, { minimumRole: 'MEMBER' });
    const result = await startScan(context, body.url === undefined ? {} : { url: body.url });

    // Best-effort: starts the work now in single-process deployments. Production
    // runs a dedicated worker, which would pick this up regardless.
    kickQueue([JOB_TYPES.websiteScan]);

    return {
      scanRunId: result.scanRun.id,
      jobId: result.jobId,
      status: result.scanRun.status,
      requestedUrl: result.scanRun.requestedUrl,
      alreadyRunning: !result.created,
    };
  },
);

/** GET /api/businesses/:businessId/scan — poll the latest scan. */
export const GET = route({}, async ({ params, user }) => {
  const businessId = params.businessId;
  if (typeof businessId !== 'string') throw validationError('businessId is required');

  const context = await requireBusinessContext(user, businessId);
  const status = await getScanStatus(context);

  return {
    phase: status.phase,
    scanRunId: status.scanRun?.id ?? null,
    status: status.scanRun?.status ?? null,
    requestedUrl: status.scanRun?.requestedUrl ?? null,
    startedAt: status.scanRun?.startedAt?.toISOString() ?? null,
    finishedAt: status.scanRun?.finishedAt?.toISOString() ?? null,
    stopReason: status.scanRun?.stopReason ?? null,
    pagesFetched: status.pagesFetched,
    pagesSkipped: status.scanRun?.pagesSkipped ?? 0,
    productsFound: status.productsFound,
    factsExtracted: status.factsExtracted,
    changeSummary: status.changeSummary,
    // Capped: a crawl can accumulate many warnings and the UI shows a summary.
    warnings: status.warnings.slice(0, 25),
  };
});

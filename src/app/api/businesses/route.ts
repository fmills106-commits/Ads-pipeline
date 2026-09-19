import { z } from 'zod';
import { route } from '@/server/api/handler';
import { createBusiness, listBusinesses } from '@/server/business/service';
import { requireWorkspaceContext } from '@/server/tenancy/context';
import { validationError } from '@/lib/errors';

const createSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  industry: z.string().trim().max(120).optional(),
  websiteUrl: z.string().url().max(2048).optional(),
  description: z.string().trim().max(2000).optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/, 'Currency must be a 3-letter ISO 4217 code')
    .optional(),
  timezone: z.string().max(64).optional(),
});

/**
 * GET /api/businesses?workspaceId=…
 *
 * The workspace id is required rather than inferred: a user may belong to
 * several workspaces, and silently defaulting to "the first one" is how
 * cross-tenant bugs start.
 */
export const GET = route({}, async ({ request, user }) => {
  const workspaceId = new URL(request.url).searchParams.get('workspaceId');
  if (!workspaceId) throw validationError('workspaceId query parameter is required');

  const context = await requireWorkspaceContext(user, workspaceId);
  const businesses = await listBusinesses(context);
  return businesses.map(serialiseBusiness);
});

/** POST /api/businesses — requires at least MEMBER in the target workspace. */
export const POST = route({ schema: createSchema }, async ({ body, user }) => {
  const context = await requireWorkspaceContext(user, body.workspaceId, {
    minimumRole: 'MEMBER',
  });
  const business = await createBusiness(context, body);
  return serialiseBusiness(business);
});

/** The client-visible shape. Internal columns stay server-side. */
function serialiseBusiness(business: {
  id: string;
  name: string;
  industry: string | null;
  websiteUrl: string | null;
  description: string | null;
  currency: string;
  timezone: string;
  automationLevel: string;
  maxDailyBudgetCents: number;
  maxCampaignBudgetCents: number;
  archivedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: business.id,
    name: business.name,
    industry: business.industry,
    websiteUrl: business.websiteUrl,
    description: business.description,
    currency: business.currency,
    timezone: business.timezone,
    automationLevel: business.automationLevel,
    maxDailyBudgetCents: business.maxDailyBudgetCents,
    maxCampaignBudgetCents: business.maxCampaignBudgetCents,
    archived: business.archivedAt !== null,
    createdAt: business.createdAt.toISOString(),
  };
}

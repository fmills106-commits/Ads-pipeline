import type { CostKind, ProviderCapability } from '@prisma/client';
import { prisma, type Db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { toAppError } from '@/lib/errors';
import { checkBudget, costLimitError, recordCost } from '@/server/cost/ledger';
import { NO_CEILINGS, selectProvider, type EnabledPaidProviders, type Selection } from './registry';
import type { Provider, ProviderResult } from './types';

/**
 * The only way to invoke a provider.
 *
 * Nothing in the application calls a provider implementation directly. Routing
 * every invocation through here is what turns the cost rules from policy into
 * mechanism:
 *
 *  - the provider is *selected* here, so zero-cost mode and per-workspace
 *    enablement are applied on every call rather than remembered at each site;
 *  - ceilings are checked *before* the call, so a request that would exceed a
 *    limit never leaves the process;
 *  - if a paid call is refused, execution falls back to the free provider
 *    rather than failing, so the feature keeps working;
 *  - a cost row is written afterwards whether the call succeeded, failed, or
 *    cost nothing. A paid call that leaves no trace is not expressible.
 */

export interface RunProviderOptions<P extends Provider, T> {
  capability: ProviderCapability;
  kind: CostKind;
  workspaceId: string;
  businessId?: string | null;
  /** Which paid providers this workspace has switched on. */
  enabledPaid?: EnabledPaidProviders;
  /** Per-provider ceilings from `provider_settings`, when configured. */
  providerDailyCents?: number | null;
  providerMonthlyCents?: number | null;
  /** Predicted cost, checked against the ceilings before the call. */
  estimatedCostCents?: number;
  /** What the call is for, so spend attributes to a feature. */
  subjectType?: string | null;
  subjectId?: string | null;
  /** The actual work. Receives the selected implementation. */
  execute: (provider: P) => Promise<ProviderResult<T>>;
  db?: Db;
  now?: Date;
}

export interface RunProviderOutcome<T> {
  value: T;
  providerKey: string;
  tier: 'LOCAL_FREE' | 'EXTERNAL_PAID';
  costCents: number;
  /**
   * Set when a paid provider was wanted but a limit sent the call to the free
   * one instead. Surfaced to the user — a silent downgrade would be the same
   * dishonesty as a silent charge.
   */
  fellBackBecause?: string;
}

export async function runProvider<P extends Provider, T>(
  options: RunProviderOptions<P, T>,
): Promise<RunProviderOutcome<T>> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const estimatedCostCents = options.estimatedCostCents ?? 0;

  const log = logger().child({
    capability: options.capability,
    workspaceId: options.workspaceId,
    businessId: options.businessId ?? undefined,
  });

  const selectionOptions = {
    capability: options.capability,
    ...(options.enabledPaid ? { enabledPaid: options.enabledPaid } : {}),
  };
  let selection: Selection = selectProvider(selectionOptions);
  let fellBackBecause: string | undefined;

  // A free selection costs nothing, so the ceiling check is skipped entirely —
  // spending limits must never be able to disable the free path.
  if (selection.descriptor.tier === 'EXTERNAL_PAID') {
    /*
     * The ceiling this workspace set for the provider that was actually
     * selected. Looked up here because selection happens here: until this
     * line nobody knows which implementation will run, and the fields were
     * stored in `provider_settings` and never read by anything for exactly
     * that reason — every call site would have had to load and forward them.
     */
    const own = options.enabledPaid?.ceilingsFor(selection.descriptor.key) ?? NO_CEILINGS;

    const decision = await checkBudget({
      workspaceId: options.workspaceId,
      tier: 'EXTERNAL_PAID',
      estimatedCostCents,
      providerDailyCents: options.providerDailyCents ?? own.dailyCents,
      providerMonthlyCents: options.providerMonthlyCents ?? own.monthlyCents,
      now,
      db,
    });

    if (!decision.allowed) {
      // Prefer degrading to free over failing. The owner gets their creative,
      // generated locally, plus a clear note about why.
      const free = selectProvider({ ...selectionOptions, zeroCostMode: true });
      if (free.descriptor.key !== selection.descriptor.key) {
        log.warn('Paid provider refused on cost grounds; using free provider', {
          refused: selection.descriptor.key,
          reason: decision.reason,
          fallback: free.descriptor.key,
        });
        selection = free;
        fellBackBecause = decision.message;
      } else {
        throw costLimitError(decision);
      }
    }
  }

  const { descriptor } = selection;
  const startedAt = Date.now();

  try {
    const result = await options.execute(selection.provider as P);

    await recordCost(
      {
        workspaceId: options.workspaceId,
        businessId: options.businessId ?? null,
        kind: options.kind,
        capability: options.capability,
        providerKey: descriptor.key,
        tier: descriptor.tier,
        model: result.usage.model ?? null,
        units: result.usage.units,
        unitLabel: result.usage.unitLabel,
        estimatedCostCents: result.usage.estimatedCostCents,
        actualCostCents: result.usage.actualCostCents,
        subjectType: options.subjectType ?? null,
        subjectId: options.subjectId ?? null,
        succeeded: true,
      },
      db,
    );

    const costCents = result.usage.actualCostCents ?? result.usage.estimatedCostCents;
    log.debug('Provider call completed', {
      provider: descriptor.key,
      tier: descriptor.tier,
      costCents,
      durationMs: Date.now() - startedAt,
    });

    return {
      value: result.value,
      providerKey: descriptor.key,
      tier: descriptor.tier,
      costCents,
      ...(fellBackBecause ? { fellBackBecause } : {}),
    };
  } catch (thrown) {
    const error = toAppError(thrown);

    // A failed paid call may still have been billed, so it is recorded at its
    // estimate rather than written off as free.
    await recordCost(
      {
        workspaceId: options.workspaceId,
        businessId: options.businessId ?? null,
        kind: options.kind,
        capability: options.capability,
        providerKey: descriptor.key,
        tier: descriptor.tier,
        units: 0,
        unitLabel: 'call',
        estimatedCostCents: descriptor.tier === 'EXTERNAL_PAID' ? estimatedCostCents : 0,
        actualCostCents: descriptor.tier === 'EXTERNAL_PAID' ? null : 0,
        subjectType: options.subjectType ?? null,
        subjectId: options.subjectId ?? null,
        succeeded: false,
        errorCode: error.code,
      },
      db,
    ).catch(() => undefined); // Never let bookkeeping mask the real failure.

    log.error('Provider call failed', {
      provider: descriptor.key,
      tier: descriptor.tier,
      error,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}

/**
 * Loads a workspace's enabled paid providers.
 *
 * Returns a set that is empty in zero-cost mode without even querying — the
 * answer cannot be anything else, and not querying makes that obvious.
 */
export async function loadEnabledPaidProviders(
  workspaceId: string,
  db: Db = prisma,
): Promise<EnabledPaidProviders> {
  const rows = await db.providerSetting.findMany({
    where: { workspaceId, enabled: true, tier: 'EXTERNAL_PAID' },
    select: { providerKey: true, maxDailyCostCents: true, maxMonthlyCostCents: true },
  });

  const byKey = new Map(rows.map((row) => [row.providerKey, row]));

  return {
    has: (key) => byKey.has(key),
    ceilingsFor: (key) => {
      const row = byKey.get(key);
      if (!row) return NO_CEILINGS;
      return {
        dailyCents: row.maxDailyCostCents,
        monthlyCents: row.maxMonthlyCostCents,
      };
    },
  };
}

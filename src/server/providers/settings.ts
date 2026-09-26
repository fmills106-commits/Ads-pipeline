import { prisma, type Db } from '@/lib/db';
import { conflict, validationError } from '@/lib/errors';
import { costCeilings, externalCredentials, isZeroCostMode } from '@/lib/env';
import { AUDIT_ACTIONS, recordAudit } from '@/server/audit/log';
import { describeProvider } from './registry';
import type { WorkspaceContext } from '@/server/tenancy/context';
import type { ProviderSetting } from '@prisma/client';

/**
 * Switching a paid provider on and off.
 *
 * This is the only screen in the application where a mistake costs money, so
 * it is the one place where refusing to act is usually the right answer. The
 * three switches from the architecture stay exactly as they were — this adds
 * the third one's missing controls, it does not merge them:
 *
 *   1. `ZERO_COST_MODE` off, in the environment
 *   2. credentials present, in the environment
 *   3. this workspace has switched the provider on   ← what was unreachable
 *
 * All three must hold before a paid call can happen, and this function can
 * only ever change the third. It refuses rather than silently storing an
 * intention that the first two would override, because a switch that reads
 * "on" while nothing paid can run is worse than one that will not flip: the
 * owner stops believing the screen.
 */

/** Why a provider cannot be switched on, in the order worth fixing. */
export type BlockedReason =
  | 'not-implemented'
  | 'zero-cost-mode'
  | 'no-credentials'
  | 'no-allowance'
  | 'unknown-provider'
  | 'not-paid';

export interface ProviderBlock {
  reason: BlockedReason;
  /** One sentence naming what to change and where. */
  message: string;
}

/**
 * What stands between this workspace and using `providerKey`, if anything.
 *
 * Exported so the screen can explain the state instead of offering a control
 * that will fail. Order matters: it names the outermost switch first, because
 * fixing an inner one while an outer one is closed changes nothing visible.
 */
export function whyBlocked(providerKey: string): ProviderBlock | null {
  const descriptor = describeProvider(providerKey);
  if (!descriptor) {
    return { reason: 'unknown-provider', message: 'That service is not one this build knows.' };
  }
  if (descriptor.tier !== 'EXTERNAL_PAID') {
    return {
      reason: 'not-paid',
      message: 'That service is free and always on; there is nothing to switch.',
    };
  }

  /*
   * Named before anything else, because no amount of configuring fixes it and
   * a switch that flips into a permanently failing state is worse than one
   * that will not flip. The descriptor exists so the interface can honestly
   * list what is coming; the adapter does not exist yet.
   */
  if (descriptor.implemented === false) {
    return {
      reason: 'not-implemented',
      message:
        'This one is not built yet, so it cannot be switched on. It is listed here because it is coming, not because it is available.',
    };
  }

  if (isZeroCostMode()) {
    return {
      reason: 'zero-cost-mode',
      message:
        'This deployment is in zero-cost mode, so no paid service can run. Set ZERO_COST_MODE=false in your hosting environment first.',
    };
  }

  if (!descriptor.isConfigured()) {
    return {
      reason: 'no-credentials',
      message:
        'No credentials for that service are configured. Add its API key to your hosting environment, redeploy, then switch it on here.',
    };
  }

  const ceilings = costCeilings();
  if (ceilings.dailyCents === 0 && ceilings.monthlyCents === 0) {
    return {
      reason: 'no-allowance',
      message:
        'The spending allowance for paid services is $0, so nothing could run. Raise MAX_DAILY_PROVIDER_COST_CENTS and MAX_MONTHLY_PROVIDER_COST_CENTS in your hosting environment first.',
    };
  }

  return null;
}

export interface SetProviderInput {
  providerKey: string;
  enabled: boolean;
  /**
   * This provider's own ceiling, in cents, or null for none of its own.
   *
   * Intersected with the platform ceiling at call time — the lower always
   * wins — so setting it here can only ever reduce what may be spent.
   */
  maxDailyCostCents?: number | null;
  maxMonthlyCostCents?: number | null;
}

const MAX_SETTABLE_CENTS = 1_000_000; // $10,000, well past any sane ceiling.

/**
 * Records this workspace's decision about one paid provider.
 *
 * Switching **off** is never refused. Whatever the environment says, an owner
 * must always be able to withdraw consent to spend — refusing that because
 * some unrelated variable is missing would be the one failure mode worth
 * avoiding at any cost.
 */
export async function setProviderEnabled(
  context: WorkspaceContext,
  input: SetProviderInput,
  db: Db = prisma,
): Promise<ProviderSetting> {
  const descriptor = describeProvider(input.providerKey);
  if (!descriptor) throw validationError('That service is not one this build knows.');
  if (descriptor.tier !== 'EXTERNAL_PAID') {
    throw validationError('Free services are always on; there is nothing to switch.');
  }

  if (input.enabled) {
    const blocked = whyBlocked(input.providerKey);
    if (blocked) throw conflict(blocked.message, { publicMessage: blocked.message });
  }

  for (const value of [input.maxDailyCostCents, input.maxMonthlyCostCents]) {
    if (value === undefined || value === null) continue;
    if (!Number.isInteger(value) || value < 0 || value > MAX_SETTABLE_CENTS) {
      throw validationError('That spending limit is not a usable amount.');
    }
  }

  const daily = input.maxDailyCostCents ?? null;
  const monthly = input.maxMonthlyCostCents ?? null;
  if (daily !== null && monthly !== null && daily > monthly) {
    throw validationError('The daily limit cannot be higher than the monthly one.');
  }

  const now = new Date();
  const setting = await db.providerSetting.upsert({
    where: {
      workspaceId_capability_providerKey: {
        workspaceId: context.workspace.id,
        capability: descriptor.capability,
        providerKey: descriptor.key,
      },
    },
    create: {
      workspaceId: context.workspace.id,
      capability: descriptor.capability,
      providerKey: descriptor.key,
      tier: descriptor.tier,
      enabled: input.enabled,
      maxDailyCostCents: daily,
      maxMonthlyCostCents: monthly,
      ...(input.enabled ? { enabledBy: context.user.id, enabledAt: now } : {}),
    },
    update: {
      enabled: input.enabled,
      maxDailyCostCents: daily,
      maxMonthlyCostCents: monthly,
      // Who turned it on, and when, is kept as it was on a switch-off: the
      // question "who let this spend money?" must stay answerable afterwards.
      ...(input.enabled ? { enabledBy: context.user.id, enabledAt: now } : {}),
    },
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      actorType: 'USER',
      actorId: context.user.id,
      action: input.enabled ? AUDIT_ACTIONS.providerEnabled : AUDIT_ACTIONS.providerDisabled,
      objectType: 'ProviderSetting',
      objectId: setting.id,
      newValue: {
        providerKey: descriptor.key,
        enabled: input.enabled,
        maxDailyCostCents: daily,
        maxMonthlyCostCents: monthly,
      },
    },
    db,
  );

  return setting;
}

/** This workspace's stored decisions, for the settings screen. */
export async function listProviderSettings(
  context: WorkspaceContext,
  db: Db = prisma,
): Promise<ProviderSetting[]> {
  return db.providerSetting.findMany({
    where: { workspaceId: context.workspace.id },
    orderBy: { providerKey: 'asc' },
  });
}

/** Whether any paid service could run at all, for a one-line summary. */
export function paidSpendPossible(): boolean {
  if (isZeroCostMode()) return false;
  const ceilings = costCeilings();
  if (ceilings.dailyCents === 0 && ceilings.monthlyCents === 0) return false;
  return Object.values(externalCredentials()).some(Boolean);
}

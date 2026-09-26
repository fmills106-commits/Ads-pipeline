import { prisma, type Db } from '@/lib/db';
import { conflict, validationError } from '@/lib/errors';
import { encryptSecret } from '@/lib/crypto';
import { costCeilings, externalCredentials, isZeroCostMode } from '@/lib/env';
import { AUDIT_ACTIONS, recordAudit } from '@/server/audit/log';
/*
 * Imported from `./index`, not from `./registry`, and that is load-bearing.
 *
 * The registry is empty until `registerAllProviders()` has run, and the only
 * thing that runs it is importing `./index`, which does so on import. Reading
 * the registry through `./registry` therefore works in a module graph that
 * happens to have pulled in `./index` for some other reason, and silently fails
 * in one that has not.
 *
 * That is not hypothetical. It is what this module did, and both API routes that
 * call into it import nothing else from the provider layer — so every request to
 * switch a paid provider on answered "That service is not one this build knows",
 * while every test passed, because the tests register the providers themselves
 * in `beforeEach`. Found by clicking the button in a browser.
 */
import { describeProvider } from './index';
import {
  acceptsOwnerKey,
  hintFor,
  loadProviderSecrets,
  secretAad,
  secretsFromEnvironment,
  type ProviderSecrets,
} from './credentials';
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
 *
 * `secrets` decides whether the credentials switch is satisfied. Left out, only
 * the deployment's environment counts — which would tell an owner who has just
 * pasted their own key that no key is configured.
 */
export function whyBlocked(
  providerKey: string,
  secrets: ProviderSecrets = secretsFromEnvironment(),
): ProviderBlock | null {
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

  if (!descriptor.isConfigured(secrets)) {
    return {
      reason: 'no-credentials',
      // Two routes, and the easy one first: a key pasted here needs no hosting
      // panel and no redeploy. The environment route stays named because a
      // deployment that supplies its own key is the other legitimate setup.
      message: acceptsOwnerKey(providerKey)
        ? 'This needs an API key. Paste yours below, or set it in this deployment’s environment and redeploy.'
        : 'No credentials for that service are configured. Add its API key to your hosting environment, redeploy, then switch it on here.',
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
    // Against this workspace's own credentials, not just the deployment's.
    // Reading the environment alone here would refuse to switch on a provider
    // whose key the owner had already pasted in, one screen up.
    const blocked = whyBlocked(
      input.providerKey,
      await loadProviderSecrets(context.workspace.id, db),
    );
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

// ---------------------------------------------------------------------------
// The owner's own API key
// ---------------------------------------------------------------------------

/**
 * Bounds on a pasted key.
 *
 * Deliberately loose about *format*. A prefix check would reject a valid key the
 * day the format changes, and this has no way to verify a key anyway — only
 * Anthropic can say whether one works, and the first real write says so clearly
 * now that failures are mapped. So this rejects what is certainly not a key and
 * accepts the rest.
 */
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 500;

export interface SetProviderKeyInput {
  providerKey: string;
  /** The key, or null to remove the one stored. */
  apiKey: string | null;
}

export interface ProviderKeyState {
  providerKey: string;
  /** Whether this workspace has a key of its own stored. */
  hasOwnKey: boolean;
  /** Last four characters of it, so an owner can recognise which key it is. */
  hint: string | null;
  setAt: Date | null;
}

/**
 * Stores, replaces or removes this workspace's own key for a paid provider.
 *
 * The point of it: before this existed, turning on the paid writer meant opening
 * the hosting platform's environment-variable panel, pasting a secret into a
 * form that cannot tell a good paste from a bad one, and redeploying. That is
 * the step that had already broken this deployment once, and it is not something
 * a shop owner should have to do to switch on a feature.
 *
 * Three rules:
 *
 *  1. **The key never comes back out.** This returns a state object with the
 *     last four characters and nothing else. There is no read path, no API route
 *     and no server action that returns a stored key.
 *  2. **Removing is never refused.** Same reasoning as switching a provider off:
 *     withdrawing the means to spend has to work whatever else is misconfigured.
 *  3. **Storing a key enables nothing.** It satisfies one of the three switches.
 *     The provider is still off until it is switched on, and still cannot run in
 *     zero-cost mode or against a zero ceiling.
 */
export async function setProviderKey(
  context: WorkspaceContext,
  input: SetProviderKeyInput,
  db: Db = prisma,
): Promise<ProviderKeyState> {
  const descriptor = describeProvider(input.providerKey);
  if (!descriptor) throw validationError('That service is not one this build knows.');
  if (descriptor.tier !== 'EXTERNAL_PAID') {
    throw validationError('Free services need no key.');
  }
  if (!acceptsOwnerKey(input.providerKey)) {
    /*
     * A provider whose adapter reads four variables — a bucket, a region and two
     * halves of an access key — is not one paste, and a box that stored a value
     * nothing reads would be worse than no box at all.
     */
    throw validationError('That service’s credentials cannot be set from here.', {
      publicMessage:
        'This service needs more than one setting, so its credentials are configured in the deployment’s environment rather than here.',
    });
  }

  const removing = input.apiKey === null;
  if (!removing) {
    const apiKey = input.apiKey ?? '';
    if (apiKey !== apiKey.trim() || /\s/.test(apiKey)) {
      // The commonest paste error, and one worth naming exactly: a key copied
      // with a line break or a trailing space fails at Anthropic with a message
      // about authentication, which sends the owner hunting the wrong problem.
      throw validationError('That key has spaces or line breaks in it.', {
        publicMessage:
          'That key has a space or a line break in it, which usually means a bit extra was copied. Copy just the key itself.',
      });
    }
    if (apiKey.length < MIN_KEY_LENGTH || apiKey.length > MAX_KEY_LENGTH) {
      throw validationError('That does not look like an API key.', {
        publicMessage: 'That does not look like an API key. Check you copied the whole thing.',
      });
    }
  }

  const now = new Date();
  const stored = removing
    ? { secretCiphertext: null, secretHint: null, secretSetBy: null, secretSetAt: null }
    : {
        secretCiphertext: encryptSecret(
          input.apiKey as string,
          secretAad(context.workspace.id, descriptor.key),
        ),
        secretHint: hintFor(input.apiKey as string),
        secretSetBy: context.user.id,
        secretSetAt: now,
      };

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
      // A key on its own turns nothing on. This is the row's first existence in
      // the common case, and it exists here as "off, with a key".
      enabled: false,
      ...stored,
    },
    update: stored,
  });

  await recordAudit(
    {
      workspaceId: context.workspace.id,
      actorType: 'USER',
      actorId: context.user.id,
      action: removing ? AUDIT_ACTIONS.providerKeyRemoved : AUDIT_ACTIONS.providerKeySet,
      objectType: 'ProviderSetting',
      objectId: setting.id,
      // The hint, never the key. An audit log is read by people and copied into
      // support tickets; a secret in one is a secret in all of those places.
      newValue: { providerKey: descriptor.key, hint: setting.secretHint },
    },
    db,
  );

  return {
    providerKey: setting.providerKey,
    hasOwnKey: setting.secretCiphertext !== null,
    hint: setting.secretHint,
    setAt: setting.secretSetAt,
  };
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

/**
 * Whether any paid service could run at all, for a one-line summary.
 *
 * Takes the workspace's credentials so the sentence is true for the owner
 * reading it: with their own key stored, paid spend *is* possible for them even
 * though the deployment supplies no credentials of its own.
 */
export function paidSpendPossible(secrets: ProviderSecrets = secretsFromEnvironment()): boolean {
  if (isZeroCostMode()) return false;
  const ceilings = costCeilings();
  if (ceilings.dailyCents === 0 && ceilings.monthlyCents === 0) return false;
  if (secrets.anthropicApiKey) return true;
  return Object.values(externalCredentials()).some(Boolean);
}

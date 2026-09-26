import type { ProviderCapability } from '@prisma/client';
import { AppError } from '@/lib/errors';
import { isZeroCostMode } from '@/lib/env';
import type { Provider, ProviderDescriptor, ProviderKey } from './types';

/**
 * The provider registry.
 *
 * Providers register themselves here; nothing else imports an implementation
 * directly. Selection is the only place that decides which implementation
 * serves a capability, and it enforces the rule the whole cost architecture
 * rests on: **a paid provider is never selected unless it was deliberately
 * enabled, and a free provider always exists to fall back to.**
 */

interface Registration {
  descriptor: ProviderDescriptor;
  create: () => Provider;
}

const registrations = new Map<ProviderKey, Registration>();

export function registerProvider(descriptor: ProviderDescriptor, create: () => Provider): void {
  if (registrations.has(descriptor.key)) {
    throw new Error(`Provider "${descriptor.key}" is already registered`);
  }
  registrations.set(descriptor.key, { descriptor, create });
}

/** Test-only: empty the registry so a test can install its own providers. */
export function resetRegistry(): void {
  registrations.clear();
}

export function describeProvider(key: ProviderKey): ProviderDescriptor | undefined {
  return registrations.get(key)?.descriptor;
}

export function listProviders(capability?: ProviderCapability): ProviderDescriptor[] {
  const all = [...registrations.values()].map((registration) => registration.descriptor);
  const filtered = capability ? all.filter((d) => d.capability === capability) : all;
  return filtered.sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key));
}

/**
 * Which paid providers a workspace has switched on.
 *
 * Passed in rather than read here so selection stays pure and testable, and so
 * a caller cannot forget that this is per-workspace.
 */
export interface ProviderCeilings {
  dailyCents: number | null;
  monthlyCents: number | null;
}

export interface EnabledPaidProviders {
  has: (key: ProviderKey) => boolean;
  /**
   * The ceiling this workspace set for one provider, if any.
   *
   * Carried here rather than passed to each call because the caller does not
   * know which implementation will be selected — that is decided inside
   * `runProvider`. Every call site would otherwise have to load the settings
   * and pass them through, and the one that forgot would spend without a cap
   * and look identical to the ones that did not.
   */
  ceilingsFor: (key: ProviderKey) => ProviderCeilings;
}

export const NO_CEILINGS: ProviderCeilings = { dailyCents: null, monthlyCents: null };

export const NO_PAID_PROVIDERS: EnabledPaidProviders = {
  has: () => false,
  ceilingsFor: () => NO_CEILINGS,
};

export interface SelectionContext {
  capability: ProviderCapability;
  enabledPaid?: EnabledPaidProviders;
  /**
   * Overrides `ZERO_COST_MODE` for this selection. Only used by tests and by
   * the Settings preview; normal call sites leave it undefined.
   */
  zeroCostMode?: boolean;
}

export interface Selection {
  descriptor: ProviderDescriptor;
  provider: Provider;
  /** Why this one — surfaced in logs and in Settings, never silent. */
  reason: 'zero-cost-mode' | 'only-free-available' | 'paid-enabled' | 'paid-not-enabled';
}

/**
 * Chooses the implementation for a capability.
 *
 * The order is deliberate and is the heart of the cost guarantee:
 *
 *  1. In zero-cost mode, only free providers are considered. Full stop — a
 *     paid provider is not merely deprioritised, it is invisible.
 *  2. Outside zero-cost mode, a paid provider is considered only if it is both
 *     configured (credentials present) and explicitly enabled for this
 *     workspace.
 *  3. If no paid provider qualifies, the highest-priority free provider is
 *     used. This branch is why the application keeps working with every
 *     external service disabled.
 *
 * @throws {AppError} CONFIGURATION_ERROR if a capability has no free provider
 * registered — a programming error, caught loudly rather than degrading.
 */
export function selectProvider(context: SelectionContext): Selection {
  const zeroCost = context.zeroCostMode ?? isZeroCostMode();
  const enabledPaid = context.enabledPaid ?? NO_PAID_PROVIDERS;

  const candidates = listProviders(context.capability).filter((d) => d.isConfigured());
  const free = candidates.filter((d) => d.tier === 'LOCAL_FREE');
  const paid = candidates.filter((d) => d.tier === 'EXTERNAL_PAID');

  const freeChoice = free[0];
  if (!freeChoice) {
    throw new AppError(
      'CONFIGURATION_ERROR',
      `No free provider is registered for capability ${context.capability}`,
      {
        details: { capability: context.capability, registered: candidates.map((d) => d.key) },
        publicMessage: 'This feature is not available in this deployment.',
      },
    );
  }

  if (zeroCost) {
    return {
      descriptor: freeChoice,
      provider: instantiate(freeChoice.key),
      reason: 'zero-cost-mode',
    };
  }

  const enabled = paid.filter((d) => enabledPaid.has(d.key));
  const paidChoice = enabled[0];

  if (paidChoice && paidChoice.priority >= freeChoice.priority) {
    return {
      descriptor: paidChoice,
      provider: instantiate(paidChoice.key),
      reason: 'paid-enabled',
    };
  }

  return {
    descriptor: freeChoice,
    provider: instantiate(freeChoice.key),
    reason: paid.length > 0 ? 'paid-not-enabled' : 'only-free-available',
  };
}

function instantiate(key: ProviderKey): Provider {
  const registration = registrations.get(key);
  if (!registration) {
    throw new AppError('CONFIGURATION_ERROR', `Provider "${key}" is not registered`);
  }
  return registration.create();
}

/**
 * A summary of what is serving each capability and what it costs.
 * Drives the Settings page, so the owner can always see LOCAL/FREE or
 * EXTERNAL/PAID at a glance.
 */
export interface CapabilityStatus {
  capability: ProviderCapability;
  activeKey: ProviderKey;
  activeLabel: string;
  tier: 'LOCAL_FREE' | 'EXTERNAL_PAID';
  reason: Selection['reason'];
  /** Paid alternatives that exist, whether or not they are usable. */
  paidAlternatives: Array<{
    key: ProviderKey;
    label: string;
    description: string;
    configured: boolean;
    enabled: boolean;
  }>;
}

export function summariseCapability(
  capability: ProviderCapability,
  enabledPaid: EnabledPaidProviders = NO_PAID_PROVIDERS,
  zeroCostMode?: boolean,
): CapabilityStatus {
  const selection = selectProvider({
    capability,
    enabledPaid,
    ...(zeroCostMode === undefined ? {} : { zeroCostMode }),
  });

  return {
    capability,
    activeKey: selection.descriptor.key,
    activeLabel: selection.descriptor.label,
    tier: selection.descriptor.tier,
    reason: selection.reason,
    paidAlternatives: listProviders(capability)
      .filter((d) => d.tier === 'EXTERNAL_PAID')
      .map((d) => ({
        key: d.key,
        label: d.label,
        description: d.description,
        configured: d.isConfigured(),
        enabled: enabledPaid.has(d.key),
      })),
  };
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listProviders,
  NO_CEILINGS,
  NO_PAID_PROVIDERS,
  registerProvider,
  resetRegistry,
  selectProvider,
  summariseCapability,
  type EnabledPaidProviders,
} from '@/server/providers/registry';
import { registerAllProviders, resetProviders } from '@/server/providers';
import type { Provider, ProviderDescriptor } from '@/server/providers/types';
import { NO_SECRETS } from '@/server/providers/credentials';

/**
 * The selection rules are the mechanism behind "never silently call a paid
 * provider" and "keeps working when every external provider is disabled", so
 * they are tested directly rather than through the things that use them.
 */

const stub = (descriptor: ProviderDescriptor): [ProviderDescriptor, () => Provider] => [
  descriptor,
  () => ({ descriptor }),
];

const freeAI: ProviderDescriptor = {
  key: 'test.ai.free',
  capability: 'AI',
  tier: 'LOCAL_FREE',
  label: 'Free AI',
  description: 'free',
  priority: 0,
  isConfigured: () => true,
};

const paidAI: ProviderDescriptor = {
  key: 'test.ai.paid',
  capability: 'AI',
  tier: 'EXTERNAL_PAID',
  label: 'Paid AI',
  description: 'paid',
  priority: 10,
  isConfigured: () => true,
};

const enabled = (...keys: string[]): EnabledPaidProviders => ({
  has: (key) => keys.includes(key),
  ceilingsFor: () => NO_CEILINGS,
});

describe('provider selection', () => {
  beforeEach(() => {
    resetRegistry();
    registerProvider(...stub(freeAI));
    registerProvider(...stub(paidAI));
  });

  afterEach(resetProviders);

  it('ignores paid providers entirely in zero-cost mode', () => {
    const selection = selectProvider({
      capability: 'AI',
      zeroCostMode: true,
      // Even explicitly enabled, a paid provider is invisible in this mode.
      enabledPaid: enabled('test.ai.paid'),
    });

    expect(selection.descriptor.key).toBe('test.ai.free');
    expect(selection.reason).toBe('zero-cost-mode');
  });

  it('uses the free provider when a paid one exists but is not enabled', () => {
    const selection = selectProvider({ capability: 'AI', zeroCostMode: false });

    expect(selection.descriptor.key).toBe('test.ai.free');
    expect(selection.reason).toBe('paid-not-enabled');
  });

  it('uses a paid provider only when zero-cost mode is off AND it is enabled', () => {
    const selection = selectProvider({
      capability: 'AI',
      zeroCostMode: false,
      enabledPaid: enabled('test.ai.paid'),
    });

    expect(selection.descriptor.key).toBe('test.ai.paid');
    expect(selection.reason).toBe('paid-enabled');
  });

  it('ignores a paid provider that has no credentials, even if enabled', () => {
    resetRegistry();
    registerProvider(...stub(freeAI));
    registerProvider(...stub({ ...paidAI, isConfigured: () => false }));

    const selection = selectProvider({
      capability: 'AI',
      zeroCostMode: false,
      enabledPaid: enabled('test.ai.paid'),
    });
    expect(selection.descriptor.key).toBe('test.ai.free');
  });

  it('reports only-free when no paid alternative exists at all', () => {
    resetRegistry();
    registerProvider(...stub(freeAI));

    expect(selectProvider({ capability: 'AI', zeroCostMode: false }).reason).toBe(
      'only-free-available',
    );
  });

  it('raises loudly when a capability has no free provider', () => {
    // A capability that can only be served by a paid service would break the
    // "works with everything disabled" guarantee, so it is a startup-class bug.
    resetRegistry();
    registerProvider(...stub(paidAI));

    expect(() => selectProvider({ capability: 'AI', zeroCostMode: false })).toThrow(
      /No free provider/,
    );
  });

  it('refuses duplicate registration of the same key', () => {
    expect(() => registerProvider(...stub(freeAI))).toThrow(/already registered/);
  });
});

describe('capability summary', () => {
  beforeEach(() => {
    resetRegistry();
    registerProvider(...stub(freeAI));
    registerProvider(...stub(paidAI));
  });

  afterEach(resetProviders);

  it('labels the active provider free or paid, so the UI can never hide it', () => {
    const summary = summariseCapability('AI', {
      enabledPaid: NO_PAID_PROVIDERS,
      zeroCostMode: true,
    });

    expect(summary.tier).toBe('LOCAL_FREE');
    expect(summary.activeLabel).toBe('Free AI');
  });

  it('lists paid alternatives with their configured and enabled state', () => {
    const summary = summariseCapability('AI', {
      enabledPaid: enabled('test.ai.paid'),
      zeroCostMode: true,
    });

    expect(summary.paidAlternatives).toEqual([
      {
        key: 'test.ai.paid',
        label: 'Paid AI',
        description: 'paid',
        configured: true,
        enabled: true,
      },
    ]);
    // Listed as enabled, but still not the active provider in zero-cost mode.
    expect(summary.activeKey).toBe('test.ai.free');
  });
});

describe('the real registry', () => {
  beforeEach(() => {
    resetProviders();
    registerAllProviders();
  });

  afterEach(resetProviders);

  it('has a free provider for every capability the app uses', () => {
    for (const capability of ['AI', 'IMAGE_GENERATION', 'ADVERTISING', 'STORAGE'] as const) {
      const free = listProviders(capability).filter((d) => d.tier === 'LOCAL_FREE');
      expect(free.length, capability).toBeGreaterThan(0);
      expect(
        free.every((d) => d.isConfigured(NO_SECRETS)),
        capability,
      ).toBe(true);
    }
  });

  it('resolves every capability to a free provider out of the box', () => {
    for (const capability of ['AI', 'IMAGE_GENERATION', 'ADVERTISING', 'STORAGE'] as const) {
      expect(selectProvider({ capability, zeroCostMode: true }).descriptor.tier, capability).toBe(
        'LOCAL_FREE',
      );
    }
  });

  it('has no paid provider configured without credentials', () => {
    // The unit test environment sets no API keys, which is the state a fresh
    // clone is in.
    const paid = listProviders().filter((d) => d.tier === 'EXTERNAL_PAID');
    expect(paid.length).toBeGreaterThan(0);
    expect(paid.every((d) => !d.isConfigured(NO_SECRETS))).toBe(true);
  });
});

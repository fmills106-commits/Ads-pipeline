import { AppError } from '@/lib/errors';
import { externalCredentials } from '@/lib/env';
import { registerProvider, resetRegistry } from './registry';
import { createLocalAIProvider, localAIDescriptor } from './local/ai';
import { createLocalImageProvider, localImageDescriptor } from './local/image';
import { createLocalStorageProvider, localStorageDescriptor } from './local/storage';
import {
  createSimulatedAdvertisingProvider,
  simulatedAdvertisingDescriptor,
} from './local/advertising';
import { createLocalWebFetchProvider, localWebFetchDescriptor } from './local/web-fetch';
import type { Provider } from './types';

/**
 * Provider bootstrap.
 *
 * Registers one free implementation per capability — the invariant
 * `selectProvider` depends on — plus the paid providers this deployment could
 * offer, so Settings can list them honestly as available-but-off rather than
 * pretending they do not exist.
 *
 * A paid provider registered here is not a paid provider in use. It is
 * unreachable until zero-cost mode is off, a cost ceiling is raised, and the
 * workspace enables it.
 */

/**
 * Paid providers whose interface exists but whose implementation lands in a
 * later phase. Declared so the UI can show what is coming without implying it
 * works. Selecting one raises rather than silently degrading.
 */
function notYetImplemented(key: string, phase: number): () => Provider {
  return () => {
    throw new AppError('CONFIGURATION_ERROR', `Provider "${key}" is not implemented yet`, {
      details: { key, phase },
      publicMessage: `That provider arrives in a later release. The free built-in option is being used instead.`,
    });
  };
}

let registered = false;

export function registerAllProviders(): void {
  if (registered) return;
  registered = true;

  // --- Free implementations: one per capability, always available ----------
  registerProvider(localAIDescriptor, createLocalAIProvider);
  registerProvider(localImageDescriptor, createLocalImageProvider);
  registerProvider(localStorageDescriptor, createLocalStorageProvider);
  registerProvider(simulatedAdvertisingDescriptor, createSimulatedAdvertisingProvider);
  registerProvider(localWebFetchDescriptor, createLocalWebFetchProvider);

  // --- Paid alternatives: declared, configured-or-not, never on by default --
  registerProvider(
    {
      key: 'ai.anthropic',
      capability: 'AI',
      tier: 'EXTERNAL_PAID',
      label: 'Claude (paid)',
      description:
        'Higher-quality strategy and ad copy, billed per token by Anthropic. Off unless you enable it.',
      priority: 10,
      isConfigured: () => externalCredentials().anthropic,
    },
    notYetImplemented('ai.anthropic', 3),
  );

  registerProvider(
    {
      key: 'image.external',
      capability: 'IMAGE_GENERATION',
      tier: 'EXTERNAL_PAID',
      label: 'External image generation (paid)',
      description:
        'Photographic and lifestyle creatives from a hosted image model, billed per image. Off unless you enable it.',
      priority: 10,
      isConfigured: () => externalCredentials().imageGeneration,
    },
    notYetImplemented('image.external', 4),
  );

  registerProvider(
    {
      key: 'storage.s3',
      capability: 'STORAGE',
      tier: 'EXTERNAL_PAID',
      label: 'S3-compatible storage (paid)',
      description:
        'For deployments running more than one instance. Free alternatives exist — self-hosted MinIO works here too.',
      priority: 10,
      isConfigured: () => externalCredentials().s3,
    },
    notYetImplemented('storage.s3', 4),
  );

  registerProvider(
    {
      key: 'webfetch.external',
      capability: 'WEB_FETCH',
      tier: 'EXTERNAL_PAID',
      label: 'Managed fetching service (paid)',
      description:
        'For sites that block direct automated access. Billed per request. The free direct fetch handles most websites.',
      priority: 10,
      // No credential variable exists for this yet, so it can never be
      // selected — it is listed so Settings can be honest that the option
      // exists and is off.
      isConfigured: () => false,
    },
    notYetImplemented('webfetch.external', 2),
  );

  registerProvider(
    {
      key: 'advertising.meta',
      capability: 'ADVERTISING',
      tier: 'EXTERNAL_PAID',
      label: 'Meta Ads (real spend)',
      description:
        'Publishes real campaigns that serve real ads and spend your advertising budget. Off unless you enable it.',
      priority: 10,
      isConfigured: () => externalCredentials().meta,
    },
    notYetImplemented('advertising.meta', 6),
  );
}

/** Test-only: clear and re-register from scratch. */
export function resetProviders(): void {
  resetRegistry();
  registered = false;
}

// Registering on import keeps every call site from having to remember to
// bootstrap. Registration is pure — it constructs nothing and reads no
// configuration until a provider is actually selected.
registerAllProviders();

export * from './types';
export {
  listProviders,
  selectProvider,
  summariseCapability,
  describeProvider,
  NO_PAID_PROVIDERS,
  type CapabilityStatus,
  type EnabledPaidProviders,
} from './registry';
export { runProvider, loadEnabledPaidProviders } from './run';

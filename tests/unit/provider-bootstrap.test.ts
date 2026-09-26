import { describe, expect, it } from 'vitest';

/**
 * The registry has to be populated by the time anything reads it.
 *
 * This file exists because of a bug that every other test passed through. The
 * provider registry is filled by `registerAllProviders()`, which runs when
 * `server/providers/index.ts` is imported — so a module that reads the registry
 * through `server/providers/registry.ts` works in a module graph that happens to
 * have imported `index` for some other reason, and silently fails in one that
 * has not.
 *
 * `providers/settings.ts` was the module that had not, and both API routes that
 * switch a paid provider on import nothing else from the provider layer. So
 * every such request answered "That service is not one this build knows" — in
 * production, on the screen an owner uses to enable the thing they are paying
 * for — while the whole suite stayed green, because the tests call
 * `registerAllProviders()` themselves in `beforeEach`. It was found by clicking
 * the button in a browser.
 *
 * So this test deliberately registers nothing, and is deliberately the only one
 * in the file. A `beforeEach` that bootstrapped the registry — or a second test
 * that imported `index` first, since module state is shared within a file —
 * would restore exactly the blind spot this exists to remove.
 */

describe('reading the registry without bootstrapping it first', () => {
  it('finds the providers from the settings module alone', async () => {
    // Exactly what the two /api/workspaces/…/providers routes import, and
    // nothing else. Before the fix, this import left the registry empty.
    const { whyBlocked } = await import('@/server/providers/settings');

    // "unknown-provider" is what an empty registry answers about everything,
    // which is how a switch that could never work looked from the browser.
    expect(whyBlocked('ai.anthropic')?.reason).not.toBe('unknown-provider');
    expect(whyBlocked('ai.local')?.reason).toBe('not-paid');
  });
});

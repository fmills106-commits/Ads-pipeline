import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { User, Workspace } from '@prisma/client';
import { prisma } from '@/lib/db';
import { registerAllProviders, resetProviders } from '@/server/providers';
import { registerProvider } from '@/server/providers/registry';
import type { AIProvider } from '@/server/providers/types';
import { loadEnabledPaidProviders } from '@/server/providers/run';
import { setProviderEnabled, whyBlocked } from '@/server/providers/settings';
import { requireWorkspaceContext } from '@/server/tenancy/context';
import { resetEnvCache } from '@/lib/env';
import { createTestUser, createTestWorkspace, resetDatabase } from '../helpers/db';

/**
 * Switching a paid service on.
 *
 * This is the only control in the application that can cause a charge, so what
 * matters is not that it works but that it refuses: a switch reading "on"
 * while nothing paid can actually run is worse than one that will not flip,
 * because the owner stops believing the screen.
 *
 * The three switches stay independent. These tests hold two of them still and
 * move the third.
 */

let user: User;
let workspace: Workspace;

const withEnv = async <T>(vars: Record<string, string>, body: () => Promise<T>): Promise<T> => {
  const previous = { ...process.env };
  Object.assign(process.env, vars);
  resetEnvCache();
  try {
    return await body();
  } finally {
    process.env = previous;
    resetEnvCache();
  }
};

const context = async () => requireWorkspaceContext(user, workspace.id);

/*
 * A paid provider that exists.
 *
 * `ai.anthropic` is now real, but it reaches out to a network service, so it is
 * not what these tests want: they are about the switches in front of a paid
 * provider, not about any particular one. The remaining paid descriptors are
 * placeholders whose adapters are not written — `implemented: false` — and those
 * are refused before any environment variable is consulted, which is correct and
 * makes them useless for testing the environment gates. So the gates are tested
 * against a provider registered here, and separate tests cover both the real one
 * and the placeholders.
 */
const PAID_KEY = 'ai.test-paid';

function registerTestPaidProvider(): void {
  registerProvider(
    {
      key: PAID_KEY,
      capability: 'AI',
      tier: 'EXTERNAL_PAID',
      label: 'Test paid AI',
      description: 'Exists only in tests.',
      priority: 10,
      isConfigured: () => Boolean(process.env['ANTHROPIC_API_KEY']),
    },
    () =>
      ({
        descriptor: { key: PAID_KEY },
        complete: async () => {
          throw new Error('not called');
        },
      }) as unknown as AIProvider,
  );
}

beforeEach(async () => {
  await resetDatabase();
  user = await createTestUser();
  workspace = await createTestWorkspace(user);
  registerAllProviders();
  registerTestPaidProvider();
});

afterEach(() => {
  resetProviders();
  resetEnvCache();
});

describe('whyBlocked', () => {
  it('names zero-cost mode first, because it overrides everything else', async () => {
    await withEnv(
      {
        ZERO_COST_MODE: 'true',
        ANTHROPIC_API_KEY: 'sk-test-key',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      },
      async () => {
        expect(whyBlocked(PAID_KEY)?.reason).toBe('zero-cost-mode');
      },
    );
  });

  it('names missing credentials once zero-cost mode is off', async () => {
    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
        ANTHROPIC_API_KEY: '',
      },
      async () => {
        expect(whyBlocked(PAID_KEY)?.reason).toBe('no-credentials');
      },
    );
  });

  it('names a zero allowance, which would otherwise look like a silent failure', async () => {
    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        ANTHROPIC_API_KEY: 'sk-test-key',
        MAX_DAILY_PROVIDER_COST_CENTS: '0',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '0',
      },
      async () => {
        expect(whyBlocked(PAID_KEY)?.reason).toBe('no-allowance');
      },
    );
  });

  it('allows it when all three are satisfied', async () => {
    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        ANTHROPIC_API_KEY: 'sk-test-key',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      },
      async () => {
        expect(whyBlocked(PAID_KEY)).toBeNull();
      },
    );
  });

  it('says a free service has nothing to switch', () => {
    expect(whyBlocked('ai.local')?.reason).toBe('not-paid');
  });

  it('refuses one whose adapter is not written, before anything else', async () => {
    /*
     * `image.external` is registered so the interface can honestly list what is
     * coming; its factory throws. Without this, the switch existed and would
     * have let an owner turn on a provider that then failed every image request
     * from then on — the worst kind of working button.
     */
    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        IMAGE_PROVIDER_API_KEY: 'test-key',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      },
      async () => {
        expect(whyBlocked('image.external')?.reason).toBe('not-implemented');
        await expect(
          setProviderEnabled(await context(), { providerKey: 'image.external', enabled: true }),
        ).rejects.toMatchObject({ code: 'CONFLICT' });
      },
    );
  });

  it('lets the real writer through once all three switches are set', async () => {
    /*
     * The inverse of the test above, and the reason that one had to change: the
     * paid writer is no longer a placeholder. An owner who has turned off
     * zero-cost mode, added a key and raised a ceiling may now switch it on —
     * and until all three of those hold, they may not.
     */
    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        ANTHROPIC_API_KEY: 'sk-test-key',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      },
      async () => {
        expect(whyBlocked('ai.anthropic')).toBeNull();

        const setting = await setProviderEnabled(await context(), {
          providerKey: 'ai.anthropic',
          enabled: true,
          maxDailyCostCents: 100,
        });

        expect(setting.enabled).toBe(true);
        expect(setting.maxDailyCostCents).toBe(100);
      },
    );
  });

  it('refuses the real writer with no key, whatever else is set', async () => {
    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        ANTHROPIC_API_KEY: '',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      },
      async () => {
        expect(whyBlocked('ai.anthropic')?.reason).toBe('no-credentials');
      },
    );
  });
});

describe('setProviderEnabled', () => {
  it('refuses to turn one on in zero-cost mode', async () => {
    // The failure mode being prevented: a stored "enabled" that the
    // environment silently overrides, so the screen and the behaviour differ.
    await withEnv({ ZERO_COST_MODE: 'true', ANTHROPIC_API_KEY: 'sk-test-key' }, async () => {
      await expect(
        setProviderEnabled(await context(), { providerKey: PAID_KEY, enabled: true }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    expect(await prisma.providerSetting.count({ where: { enabled: true } })).toBe(0);
  });

  it('turns one off even when the environment would block turning it on', async () => {
    // Withdrawing permission to spend must never depend on anything else.
    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        ANTHROPIC_API_KEY: 'sk-test-key',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      },
      async () => {
        await setProviderEnabled(await context(), { providerKey: PAID_KEY, enabled: true });
      },
    );

    await withEnv({ ZERO_COST_MODE: 'true' }, async () => {
      const off = await setProviderEnabled(await context(), {
        providerKey: PAID_KEY,
        enabled: false,
      });
      expect(off.enabled).toBe(false);
    });
  });

  it('records who turned it on, and keeps that after it is turned off', async () => {
    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        ANTHROPIC_API_KEY: 'sk-test-key',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      },
      async () => {
        const ctx = await context();
        await setProviderEnabled(ctx, { providerKey: PAID_KEY, enabled: true });
        const off = await setProviderEnabled(ctx, { providerKey: PAID_KEY, enabled: false });

        // "Who let this spend money?" must stay answerable afterwards.
        expect(off.enabledBy).toBe(user.id);
        expect(off.enabledAt).not.toBeNull();

        const audit = await prisma.auditLog.findMany({
          where: { action: { in: ['provider.enabled', 'provider.disabled'] } },
          orderBy: { createdAt: 'asc' },
        });
        expect(audit.map((row) => row.action)).toEqual(['provider.enabled', 'provider.disabled']);
        expect(audit[0]?.actorId).toBe(user.id);
      },
    );
  });

  it('refuses a daily limit above the monthly one', async () => {
    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        ANTHROPIC_API_KEY: 'sk-test-key',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      },
      async () => {
        await expect(
          setProviderEnabled(await context(), {
            providerKey: PAID_KEY,
            enabled: true,
            maxDailyCostCents: 5_000,
            maxMonthlyCostCents: 100,
          }),
        ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      },
    );
  });

  it('refuses a limit that is not a usable amount', async () => {
    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        ANTHROPIC_API_KEY: 'sk-test-key',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      },
      async () => {
        for (const bad of [-1, 2_000_000, 1.5]) {
          await expect(
            setProviderEnabled(await context(), {
              providerKey: PAID_KEY,
              enabled: true,
              maxDailyCostCents: bad,
            }),
          ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
        }
      },
    );
  });

  it('makes the stored ceiling reach the thing that enforces it', async () => {
    /*
     * The gap this closes: provider_settings has carried maxDailyCostCents
     * since Phase 2 and the cost ledger has always accepted it, but nothing
     * ever passed one — so a ceiling set here would have been stored and
     * ignored, which is the worst possible outcome for a spending limit.
     */
    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        ANTHROPIC_API_KEY: 'sk-test-key',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      },
      async () => {
        await setProviderEnabled(await context(), {
          providerKey: PAID_KEY,
          enabled: true,
          maxDailyCostCents: 200,
          maxMonthlyCostCents: 1_000,
        });

        const loaded = await loadEnabledPaidProviders(workspace.id);
        expect(loaded.has(PAID_KEY)).toBe(true);
        expect(loaded.ceilingsFor(PAID_KEY)).toEqual({
          dailyCents: 200,
          monthlyCents: 1_000,
        });
      },
    );
  });

  it('keeps one workspace’s decision out of another’s', async () => {
    const other = await createTestWorkspace(await createTestUser({ email: 'other@example.com' }));

    await withEnv(
      {
        ZERO_COST_MODE: 'false',
        ANTHROPIC_API_KEY: 'sk-test-key',
        MAX_DAILY_PROVIDER_COST_CENTS: '500',
        MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
      },
      async () => {
        await setProviderEnabled(await context(), { providerKey: PAID_KEY, enabled: true });

        expect((await loadEnabledPaidProviders(workspace.id)).has(PAID_KEY)).toBe(true);
        expect((await loadEnabledPaidProviders(other.id)).has(PAID_KEY)).toBe(false);
      },
    );
  });
});

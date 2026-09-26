import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { User, Workspace } from '@prisma/client';
import { prisma } from '@/lib/db';
import { encryptSecret } from '@/lib/crypto';
import { resetEnvCache } from '@/lib/env';
import { registerAllProviders, resetProviders } from '@/server/providers';
import { selectProvider } from '@/server/providers/registry';
import { loadProviderSecrets, secretAad } from '@/server/providers/credentials';
import { loadPaidProviderState } from '@/server/providers/run';
import { setProviderEnabled, setProviderKey, whyBlocked } from '@/server/providers/settings';
import { requireWorkspaceContext } from '@/server/tenancy/context';
import { createTestUser, createTestWorkspace, resetDatabase } from '../helpers/db';

/**
 * An owner's own API key.
 *
 * Before this existed, enabling the paid writer meant opening the hosting
 * platform's environment-variable panel, pasting a secret into a form that
 * cannot tell a good paste from a bad one, and redeploying — the same panel that
 * had already broken this deployment once. These tests are about the two things
 * that have to be true for moving that into the application to be an
 * improvement rather than a liability: the key is unreadable at rest and never
 * comes back out, and storing one grants nothing on its own.
 */

const KEY = 'sk-ant-test-0000000000000000000000000000-Ab3d';
const PROVIDER = 'ai.anthropic';

let user: User;
let workspace: Workspace;
let otherWorkspace: Workspace;

const context = async () => requireWorkspaceContext(user, workspace.id);

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

/** Everything needed for a paid call except the key itself. */
const SPENDING_ALLOWED = {
  ZERO_COST_MODE: 'false',
  ANTHROPIC_API_KEY: '',
  MAX_DAILY_PROVIDER_COST_CENTS: '500',
  MAX_MONTHLY_PROVIDER_COST_CENTS: '5000',
};

const row = async () =>
  prisma.providerSetting.findFirst({ where: { workspaceId: workspace.id, providerKey: PROVIDER } });

beforeEach(async () => {
  await resetDatabase();
  user = await createTestUser();
  workspace = await createTestWorkspace(user);
  otherWorkspace = await createTestWorkspace(user);
  registerAllProviders();
});

afterEach(() => {
  resetProviders();
  resetEnvCache();
});

describe('storing a key', () => {
  it('never returns the key, only its last four characters', async () => {
    const state = await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });

    expect(state.hasOwnKey).toBe(true);
    expect(state.hint).toBe('Ab3d');
    expect(JSON.stringify(state)).not.toContain(KEY);
  });

  it('writes it encrypted, never in plain text', async () => {
    await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });

    const stored = await row();
    expect(stored?.secretCiphertext).toBeTruthy();
    expect(stored?.secretCiphertext).not.toContain(KEY);
    // Self-describing ciphertext, so a later key rotation knows how this row
    // was encoded rather than guessing.
    expect(stored?.secretCiphertext?.startsWith('v1.')).toBe(true);
    expect(stored?.secretHint).toBe('Ab3d');
  });

  it('records who set it, and when', async () => {
    await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });

    const stored = await row();
    expect(stored?.secretSetBy).toBe(user.id);
    expect(stored?.secretSetAt).toBeInstanceOf(Date);
  });

  it('switches nothing on', async () => {
    await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });

    // The whole point of the three switches. A key is the means to spend; it is
    // not permission, and this row must read "off, with a key".
    expect((await row())?.enabled).toBe(false);
    expect(await prisma.providerSetting.count({ where: { enabled: true } })).toBe(0);
  });

  it('keeps the key out of the audit log', async () => {
    await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });

    const entries = await prisma.auditLog.findMany({ where: { workspaceId: workspace.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('provider.key_set');
    // Audit rows are read by people and pasted into support tickets.
    expect(JSON.stringify(entries[0]?.newValue)).not.toContain(KEY);
    expect(JSON.stringify(entries[0]?.newValue)).toContain('Ab3d');
  });

  it('replaces one key with another', async () => {
    await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });
    const state = await setProviderKey(await context(), {
      providerKey: PROVIDER,
      apiKey: 'sk-ant-second-key-0000000000000000-Zz99',
    });

    expect(state.hint).toBe('Zz99');
    expect(await loadProviderSecrets(workspace.id)).toMatchObject({
      anthropicApiKey: 'sk-ant-second-key-0000000000000000-Zz99',
    });
  });
});

describe('refusing a paste that cannot be a key', () => {
  it('names a line break rather than letting Anthropic reject it', async () => {
    /*
     * The commonest paste error by far, and the one where a generic message
     * costs the most time: a key with a trailing newline fails at Anthropic as
     * an authentication error, which sends the owner hunting for a problem with
     * their account.
     */
    await expect(
      setProviderKey(await context(), { providerKey: PROVIDER, apiKey: `${KEY}\n` }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(await row()).toBeNull();
  });

  it('refuses something far too short to be a key', async () => {
    await expect(
      setProviderKey(await context(), { providerKey: PROVIDER, apiKey: 'sk-ant-oops' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a service whose credentials are more than one paste', async () => {
    // S3 needs a bucket, a region and two halves of an access key. A box that
    // stored one value nothing reads would be worse than no box.
    await expect(
      setProviderKey(await context(), { providerKey: 'storage.s3', apiKey: KEY }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses a free service, which needs no key', async () => {
    await expect(
      setProviderKey(await context(), { providerKey: 'ai.local', apiKey: KEY }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('removing a key', () => {
  it('clears every trace of it', async () => {
    await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });
    const state = await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: null });

    expect(state.hasOwnKey).toBe(false);
    expect(state.hint).toBeNull();

    const stored = await row();
    expect(stored?.secretCiphertext).toBeNull();
    expect(stored?.secretHint).toBeNull();
    expect(stored?.secretSetAt).toBeNull();
  });

  it('is never refused, whatever else is misconfigured', async () => {
    await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });

    // Zero-cost mode refuses switching a provider *on*. Withdrawing the means to
    // spend has to work regardless — that asymmetry is deliberate.
    await withEnv({ ZERO_COST_MODE: 'true' }, async () => {
      const state = await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: null });
      expect(state.hasOwnKey).toBe(false);
    });
  });

  it('falls back to the deployment’s key if it has one', async () => {
    await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });
    await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: null });

    await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-from-the-environment' }, async () => {
      const secrets = await loadProviderSecrets(workspace.id);
      expect(secrets.anthropicApiKey).toBe('sk-ant-from-the-environment');
      expect(secrets.sources.anthropic).toBe('environment');
    });
  });
});

describe('which key wins', () => {
  it('prefers the workspace’s own over the deployment’s', async () => {
    await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });

    await withEnv({ ANTHROPIC_API_KEY: 'sk-ant-operators-key' }, async () => {
      const secrets = await loadProviderSecrets(workspace.id);
      // The owner's key means the owner is paying, and it is the one they can
      // see and change. Silently preferring the operator's key — and their
      // bill — would be the wrong way round.
      expect(secrets.anthropicApiKey).toBe(KEY);
      expect(secrets.sources.anthropic).toBe('workspace');
    });
  });

  it('keeps one workspace’s key out of another’s reach', async () => {
    await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });

    const secrets = await loadProviderSecrets(otherWorkspace.id);
    expect(secrets.anthropicApiKey).toBeUndefined();
  });

  it('will not decrypt a ciphertext copied from another workspace', async () => {
    /*
     * The ciphertext is bound to its workspace and provider. A row copied
     * between workspaces — by a bad migration, a restore, or someone with
     * database access — fails its authentication tag instead of decrypting into
     * a key somebody else is paying for.
     */
    const foreign = encryptSecret(KEY, secretAad(workspace.id, PROVIDER));
    await prisma.providerSetting.create({
      data: {
        workspaceId: otherWorkspace.id,
        capability: 'AI',
        providerKey: PROVIDER,
        tier: 'EXTERNAL_PAID',
        enabled: false,
        secretCiphertext: foreign,
        secretHint: 'Ab3d',
      },
    });

    const secrets = await loadProviderSecrets(otherWorkspace.id);
    expect(secrets.anthropicApiKey).toBeUndefined();
    expect(secrets.sources.anthropic).toBe('none');
  });

  it('treats an undecryptable key as absent rather than failing every call', async () => {
    // What a rotated ENCRYPTION_KEY or a database restored into a different
    // deployment looks like. The free provider still works, and the owner can
    // see that their key needs re-entering.
    await prisma.providerSetting.create({
      data: {
        workspaceId: workspace.id,
        capability: 'AI',
        providerKey: PROVIDER,
        tier: 'EXTERNAL_PAID',
        enabled: true,
        secretCiphertext: 'v1.bm90.YXQ.YWxs',
        secretHint: 'Ab3d',
      },
    });

    const secrets = await loadProviderSecrets(workspace.id);
    expect(secrets.anthropicApiKey).toBeUndefined();
  });
});

describe('what a stored key unlocks', () => {
  it('satisfies the credentials switch with nothing in the environment', async () => {
    await withEnv(SPENDING_ALLOWED, async () => {
      // Before the key: blocked for want of credentials, and the message points
      // at the box rather than at a hosting panel.
      expect(whyBlocked(PROVIDER, await loadProviderSecrets(workspace.id))?.reason).toBe(
        'no-credentials',
      );

      await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });

      expect(whyBlocked(PROVIDER, await loadProviderSecrets(workspace.id))).toBeNull();
    });
  });

  it('lets the owner switch the writer on without touching the environment', async () => {
    await withEnv(SPENDING_ALLOWED, async () => {
      await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });

      const setting = await setProviderEnabled(await context(), {
        providerKey: PROVIDER,
        enabled: true,
        maxDailyCostCents: 50,
      });

      expect(setting.enabled).toBe(true);
      // And the key survived being switched on: the two are separate columns
      // written by separate functions, which is exactly where a bug would hide.
      expect((await row())?.secretCiphertext).toBeTruthy();
    });
  });

  it('is what selection actually runs on', async () => {
    await withEnv(SPENDING_ALLOWED, async () => {
      await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });
      await setProviderEnabled(await context(), { providerKey: PROVIDER, enabled: true });

      const { enabledPaid, secrets } = await loadPaidProviderState(workspace.id);
      const selection = selectProvider({ capability: 'AI', enabledPaid, secrets });

      expect(selection.descriptor.key).toBe(PROVIDER);
      expect(selection.reason).toBe('paid-enabled');
    });
  });

  it('still runs on the free provider in zero-cost mode', async () => {
    await withEnv({ ...SPENDING_ALLOWED, ZERO_COST_MODE: 'false' }, async () => {
      await setProviderKey(await context(), { providerKey: PROVIDER, apiKey: KEY });
      await setProviderEnabled(await context(), { providerKey: PROVIDER, enabled: true });
    });

    // A key and an enabled switch, and the deployment still says no.
    await withEnv({ ZERO_COST_MODE: 'true' }, async () => {
      const { enabledPaid, secrets } = await loadPaidProviderState(workspace.id);
      const selection = selectProvider({ capability: 'AI', enabledPaid, secrets });

      expect(selection.descriptor.key).toBe('ai.local');
      expect(selection.reason).toBe('zero-cost-mode');
    });
  });
});

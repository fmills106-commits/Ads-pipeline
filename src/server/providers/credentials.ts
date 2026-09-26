import { prisma, type Db } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';
import { getEnv } from '@/lib/env';
import { logger } from '@/lib/logger';
import type { ProviderKey } from './types';

/**
 * Where a paid provider's credentials come from.
 *
 * There are two answers and they are not equivalent, so the type says which one
 * applied rather than handing back an anonymous string:
 *
 *  - **The environment.** The operator of the deployment supplied it, which
 *    means the operator is paying. Right for someone hosting this for their own
 *    shop, or for a host who bills their users some other way.
 *  - **The workspace.** The owner pasted it into Settings, which means the owner
 *    is paying, and they can change or remove it themselves without touching a
 *    hosting panel or waiting for a redeploy.
 *
 * The workspace's own key wins where both exist. It is the more specific of the
 * two and the one its owner can see, so silently preferring the operator's key —
 * and their bill — would be the wrong way round.
 *
 * Nothing here decides whether a paid call may happen. That is still the three
 * switches: zero-cost mode off, a ceiling above zero, and the provider enabled
 * for the workspace. A credential satisfies exactly one of them.
 */

export type CredentialSource = 'workspace' | 'environment' | 'none';

export interface ProviderSecrets {
  /** The Anthropic key, whichever source supplied it. Absent means none exists. */
  anthropicApiKey?: string;
  /** Which source each credential came from, for honest reporting in Settings. */
  sources: Record<'anthropic', CredentialSource>;
}

/** No credentials at all. The state every test and every free path runs in. */
export const NO_SECRETS: ProviderSecrets = { sources: { anthropic: 'none' } };

/** What the deployment's environment supplies, with no workspace consulted. */
export function secretsFromEnvironment(): ProviderSecrets {
  const key = getEnv().ANTHROPIC_API_KEY;
  return {
    ...(key ? { anthropicApiKey: key } : {}),
    sources: { anthropic: key ? 'environment' : 'none' },
  };
}

/** Which provider key each credential field belongs to. */
const OWNED_BY: Record<ProviderKey, keyof Omit<ProviderSecrets, 'sources'>> = {
  'ai.anthropic': 'anthropicApiKey',
};

/**
 * Whether a provider is one an owner can supply their own key for.
 *
 * Exported so the interface only offers the form where it would work. A
 * provider whose adapter reads several variables — a bucket name, a region and
 * two halves of an access key — is not a single paste, and pretending otherwise
 * would produce a box that stores a value nothing reads.
 */
export function acceptsOwnerKey(providerKey: ProviderKey): boolean {
  return providerKey in OWNED_BY;
}

/**
 * The credentials in force for one workspace.
 *
 * Reads `provider_settings` for stored keys and falls back to the environment
 * per provider, so a deployment can supply one and an owner another.
 *
 * A stored key that cannot be decrypted is treated as absent and logged loudly.
 * That happens when `ENCRYPTION_KEY` changes — someone rotated it, or restored a
 * database into a different deployment — and the honest response is to behave as
 * though no key is configured, which sends the work to the free provider and
 * shows the owner that their key needs re-entering. The alternative, failing
 * every AI call, would take the whole feature down over a credential that is
 * optional by design.
 */
export async function loadProviderSecrets(
  workspaceId: string,
  db: Db = prisma,
): Promise<ProviderSecrets> {
  const rows = await db.providerSetting.findMany({
    where: { workspaceId, tier: 'EXTERNAL_PAID', secretCiphertext: { not: null } },
    select: { providerKey: true, secretCiphertext: true },
  });

  const secrets: ProviderSecrets = { ...secretsFromEnvironment() };

  for (const row of rows) {
    const field = OWNED_BY[row.providerKey];
    if (!field || !row.secretCiphertext) continue;

    const plaintext = decrypt(row.secretCiphertext, workspaceId, row.providerKey);
    if (!plaintext) continue;

    secrets[field] = plaintext;
    secrets.sources.anthropic = 'workspace';
  }

  return secrets;
}

/**
 * The data this ciphertext is bound to.
 *
 * Binding the workspace and provider key in means a row copied between
 * workspaces, or moved to a different provider, fails its authentication tag
 * instead of decrypting into a key someone else is paying for.
 */
export function secretAad(workspaceId: string, providerKey: ProviderKey): string {
  return `provider-secret:${workspaceId}:${providerKey}`;
}

function decrypt(ciphertext: string, workspaceId: string, providerKey: ProviderKey): string | null {
  try {
    return decryptSecret(ciphertext, secretAad(workspaceId, providerKey));
  } catch (error) {
    logger().error('Stored provider key could not be decrypted; treating it as absent', {
      workspaceId,
      providerKey,
      error,
    });
    return null;
  }
}

/** The last four characters, which is all that is ever stored or shown. */
export function hintFor(apiKey: string): string {
  return apiKey.slice(-4);
}

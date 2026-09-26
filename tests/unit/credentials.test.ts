import { afterEach, describe, expect, it } from 'vitest';
import { resetEnvCache } from '@/lib/env';
import {
  acceptsOwnerKey,
  hintFor,
  NO_SECRETS,
  secretAad,
  secretsFromEnvironment,
} from '@/server/providers/credentials';

/**
 * Where a paid provider's key comes from.
 *
 * The parts that need a database are in `tests/db/provider-key.test.ts`. These
 * are the rules that hold with no workspace in hand at all.
 */

const withEnv = (vars: Record<string, string>, body: () => void): void => {
  const previous = { ...process.env };
  Object.assign(process.env, vars);
  resetEnvCache();
  try {
    body();
  } finally {
    process.env = previous;
    resetEnvCache();
  }
};

afterEach(resetEnvCache);

describe('credentials from the environment', () => {
  it('reports none when the deployment has none', () => {
    withEnv({ ANTHROPIC_API_KEY: '' }, () => {
      const secrets = secretsFromEnvironment();
      expect(secrets.anthropicApiKey).toBeUndefined();
      expect(secrets.sources.anthropic).toBe('none');
    });
  });

  it('says where a key came from, not just that there is one', () => {
    // Which source it was decides who is paying, and the Settings screen says
    // so out loud. An anonymous string could not.
    withEnv({ ANTHROPIC_API_KEY: 'sk-ant-operators-key' }, () => {
      expect(secretsFromEnvironment().sources.anthropic).toBe('environment');
    });
  });

  it('has an explicit nothing, for the paths that must not read the environment', () => {
    expect(NO_SECRETS.anthropicApiKey).toBeUndefined();
    expect(NO_SECRETS.sources.anthropic).toBe('none');
  });
});

describe('which providers can take an owner’s key', () => {
  it('accepts one for the service whose credential is a single key', () => {
    expect(acceptsOwnerKey('ai.anthropic')).toBe(true);
  });

  it('refuses for services that need more than one setting', () => {
    // S3 needs a bucket, a region and two halves of an access key; Meta needs an
    // app id and a secret. A single paste box would store something nothing
    // reads, which is worse than no box at all.
    expect(acceptsOwnerKey('storage.s3')).toBe(false);
    expect(acceptsOwnerKey('advertising.meta')).toBe(false);
  });

  it('refuses for anything it has never heard of', () => {
    expect(acceptsOwnerKey('ai.something-else')).toBe(false);
  });
});

describe('how a stored key is protected', () => {
  it('binds ciphertext to one workspace and one provider', () => {
    // Different workspace, different additional data, so a copied row fails to
    // decrypt rather than yielding a key someone else is paying for.
    expect(secretAad('workspace-a', 'ai.anthropic')).not.toBe(
      secretAad('workspace-b', 'ai.anthropic'),
    );
    expect(secretAad('workspace-a', 'ai.anthropic')).not.toBe(
      secretAad('workspace-a', 'image.external'),
    );
  });

  it('keeps only the last four characters as a hint', () => {
    expect(hintFor('sk-ant-0000000000000000000000-Ab3d')).toBe('Ab3d');
  });
});

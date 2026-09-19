import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword } from '@/server/auth/password';

/** Production parameters take ~1s per hash; tests use a cheap cost. */
const FAST = { N: 2 ** 10, r: 8, p: 1 } as const;

describe('password hashing', () => {
  it('produces a self-describing encoded hash', async () => {
    const encoded = await hashPassword('correct-horse-battery-staple', FAST);
    const [scheme, N, r, p, salt, key] = encoded.split('$');

    expect(scheme).toBe('scrypt');
    expect(Number(N)).toBe(FAST.N);
    expect(Number(r)).toBe(FAST.r);
    expect(Number(p)).toBe(FAST.p);
    expect(Buffer.from(salt!, 'base64')).toHaveLength(16);
    expect(Buffer.from(key!, 'base64')).toHaveLength(64);
  });

  it('salts, so the same password hashes differently each time', async () => {
    const a = await hashPassword('correct-horse-battery-staple', FAST);
    const b = await hashPassword('correct-horse-battery-staple', FAST);
    expect(a).not.toBe(b);
  });

  it('verifies the correct password', async () => {
    const encoded = await hashPassword('correct-horse-battery-staple', FAST);
    await expect(verifyPassword('correct-horse-battery-staple', encoded)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const encoded = await hashPassword('correct-horse-battery-staple', FAST);
    await expect(verifyPassword('correct-horse-battery-stapl', encoded)).resolves.toBe(false);
    await expect(verifyPassword('', encoded)).resolves.toBe(false);
  });

  it('normalises Unicode so an equivalent password still verifies', async () => {
    // "é" composed vs decomposed — the same password from the user's point of view.
    const encoded = await hashPassword('passwordé-long-enough', FAST);
    await expect(verifyPassword('passwordé-long-enough', encoded)).resolves.toBe(true);
  });

  it('enforces a minimum length', async () => {
    await expect(hashPassword('short', FAST)).rejects.toThrow(/at least 12/);
  });

  it('enforces a maximum length — unbounded input into a KDF is a DoS vector', async () => {
    await expect(hashPassword('a'.repeat(257), FAST)).rejects.toThrow(/at most 256/);
    await expect(verifyPassword('a'.repeat(5_000), 'scrypt$1024$8$1$AAAA$BBBB')).resolves.toBe(
      false,
    );
  });

  describe('malformed stored hashes deny the login instead of throwing', () => {
    const malformed = [
      '',
      'not-a-hash',
      'bcrypt$10$salt$key',
      'scrypt$1024$8$1$onlyfiveparts',
      'scrypt$notanumber$8$1$AAAA$BBBB',
      'scrypt$1000$8$1$AAAA$BBBB', // N is not a power of two
      'scrypt$1024$8$1$$BBBB', // empty salt
    ];

    for (const encoded of malformed) {
      it(JSON.stringify(encoded), async () => {
        await expect(verifyPassword('correct-horse-battery-staple', encoded)).resolves.toBe(false);
      });
    }
  });
});

describe('needsRehash', () => {
  it('flags hashes made with weaker parameters than the current default', async () => {
    expect(needsRehash(await hashPassword('correct-horse-battery-staple', FAST))).toBe(true);
  });

  it('flags unparseable hashes', () => {
    expect(needsRehash('garbage')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, isEncryptedPayload } from '@/lib/crypto';

/**
 * These cover the mechanism that will hold live Meta access tokens. An
 * ad-account token that can spend a merchant's money must not survive a
 * database dump, and must not decrypt if it has been tampered with.
 */
describe('secret encryption', () => {
  const token = 'EAAG0ZC-example-long-lived-access-token';

  it('round-trips a value', () => {
    expect(decryptSecret(encryptSecret(token))).toBe(token);
  });

  it('produces different ciphertext each time (random nonce)', () => {
    expect(encryptSecret(token)).not.toBe(encryptSecret(token));
  });

  it('never contains the plaintext', () => {
    expect(encryptSecret(token)).not.toContain('EAAG0ZC');
  });

  it('is version-tagged so keys can be rotated later', () => {
    const payload = encryptSecret(token);
    expect(payload.startsWith('v1.')).toBe(true);
    expect(isEncryptedPayload(payload)).toBe(true);
    expect(isEncryptedPayload('plaintext')).toBe(false);
  });

  it('round-trips unicode and empty strings', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('');
    expect(decryptSecret(encryptSecret('日本語 🎯 café'))).toBe('日本語 🎯 café');
  });

  it('rejects a tampered ciphertext', () => {
    const payload = encryptSecret(token);
    const parts = payload.split('.');
    const flipped = Buffer.from(parts[3]!, 'base64url');
    flipped[0] = (flipped[0]! ^ 0xff) & 0xff;
    parts[3] = flipped.toString('base64url');

    expect(() => decryptSecret(parts.join('.'))).toThrow(/Failed to decrypt/);
  });

  it('rejects a tampered authentication tag', () => {
    const parts = encryptSecret(token).split('.');
    const tag = Buffer.from(parts[2]!, 'base64url');
    tag[0] = (tag[0]! ^ 0x01) & 0xff;
    parts[2] = tag.toString('base64url');

    expect(() => decryptSecret(parts.join('.'))).toThrow(/Failed to decrypt/);
  });

  it('rejects malformed payloads', () => {
    expect(() => decryptSecret('nonsense')).toThrow(/Malformed/);
    expect(() => decryptSecret('v2.a.b.c')).toThrow(/Malformed/);
    expect(() => decryptSecret('v1.short.tag.body')).toThrow(/Malformed/);
  });

  describe('additional authenticated data', () => {
    it('round-trips when the aad matches', () => {
      const payload = encryptSecret(token, 'integration:abc');
      expect(decryptSecret(payload, 'integration:abc')).toBe(token);
    });

    it('fails when the aad differs — a token row moved to another integration', () => {
      const payload = encryptSecret(token, 'integration:abc');
      expect(() => decryptSecret(payload, 'integration:xyz')).toThrow(/Failed to decrypt/);
    });

    it('fails when the aad is omitted on decrypt', () => {
      const payload = encryptSecret(token, 'integration:abc');
      expect(() => decryptSecret(payload)).toThrow(/Failed to decrypt/);
    });
  });
});

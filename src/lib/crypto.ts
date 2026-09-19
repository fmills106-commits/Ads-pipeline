import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getEnv } from './env';
import { AppError } from './errors';

/**
 * Authenticated encryption for secrets held at rest.
 *
 * This exists for one job above all: Meta (and later Google, TikTok) OAuth
 * access tokens. Those tokens can spend a merchant's money, so they are never
 * written to the database in plaintext and never cross into the client bundle.
 *
 * AES-256-GCM. Ciphertext is self-describing:
 *   v1.<iv base64url>.<authTag base64url>.<ciphertext base64url>
 * The version prefix is what makes key rotation possible later without
 * guessing at how an old row was encoded.
 */

const VERSION = 'v1';
const IV_BYTES = 12; // 96-bit nonce, as recommended for GCM.
const AUTH_TAG_BYTES = 16;

function key(): Buffer {
  const raw = Buffer.from(getEnv().ENCRYPTION_KEY, 'base64');
  if (raw.length !== 32) {
    throw new AppError('CONFIGURATION_ERROR', 'ENCRYPTION_KEY must decode to exactly 32 bytes');
  }
  return raw;
}

/**
 * Encrypts a UTF-8 string.
 *
 * `aad` binds the ciphertext to its context — pass something like
 * `integration:<id>` so a token row copied to a different integration fails
 * to decrypt rather than silently working.
 */
export function encryptSecret(plaintext: string, aad?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key(), iv, { authTagLength: AUTH_TAG_BYTES });
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypts a value produced by `encryptSecret`.
 *
 * @throws {AppError} CONFIGURATION_ERROR if the payload is malformed, was
 * encrypted under a different key, or fails its authentication tag. Tampering
 * and key mismatch are indistinguishable by design.
 */
export function decryptSecret(payload: string, aad?: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new AppError('CONFIGURATION_ERROR', 'Malformed encrypted payload', {
      details: { version: parts[0] ?? null, segments: parts.length },
    });
  }

  const [, rawIv, rawTag, rawCiphertext] = parts;
  const iv = Buffer.from(rawIv ?? '', 'base64url');
  const authTag = Buffer.from(rawTag ?? '', 'base64url');
  if (iv.length !== IV_BYTES || authTag.length !== AUTH_TAG_BYTES) {
    throw new AppError('CONFIGURATION_ERROR', 'Malformed encrypted payload header');
  }

  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAuthTag(authTag);
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
    return Buffer.concat([
      decipher.update(Buffer.from(rawCiphertext ?? '', 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (cause) {
    throw new AppError('CONFIGURATION_ERROR', 'Failed to decrypt payload', { cause });
  }
}

/** True if `value` looks like output of `encryptSecret` (does not verify it). */
export const isEncryptedPayload = (value: string): boolean => value.startsWith(`${VERSION}.`);

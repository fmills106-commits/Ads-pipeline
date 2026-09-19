import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/lib/auth-constants';

/**
 * Password hashing with scrypt.
 *
 * scrypt is memory-hard, is in the Node standard library, and needs no native
 * build step — which matters for a project that has to run identically on a
 * developer laptop, in CI, and in a container. Parameters are stored inside the
 * hash string so they can be raised later without invalidating existing users.
 *
 * Encoded format: `scrypt$N$r$p$<salt base64>$<derived key base64>`
 */

interface ScryptOptions {
  N: number;
  r: number;
  p: number;
  maxmem: number;
}

/**
 * `promisify` cannot see through `scrypt`'s overloads, so the options-taking
 * signature is restated here rather than lost to `any`.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/** OWASP-recommended minimum for scrypt: N=2^17, r=8, p=1. */
const DEFAULT_PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const;

const SALT_BYTES = 16;
const KEY_BYTES = 64;

/** scrypt needs roughly `128 * N * r` bytes; the default 32 MiB cap is too low. */
const maxmem = (N: number, r: number): number => 256 * N * r;

export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '@/lib/auth-constants';

export async function hashPassword(
  password: string,
  params: { N: number; r: number; p: number } = DEFAULT_PARAMS,
): Promise<string> {
  assertPasswordLength(password);
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_BYTES, {
    ...params,
    maxmem: maxmem(params.N, params.r),
  });

  return [
    'scrypt',
    params.N,
    params.r,
    params.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Constant-time verification.
 *
 * Returns `false` rather than throwing on a malformed stored hash: a corrupt
 * row should deny the login, not crash the endpoint.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parseEncoded(encoded);
  if (!parsed) return false;
  if (password.length > PASSWORD_MAX_LENGTH) return false;

  const { N, r, p, salt, key } = parsed;
  let derived: Buffer;
  try {
    derived = await scrypt(password.normalize('NFKC'), salt, key.length, {
      N,
      r,
      p,
      maxmem: maxmem(N, r),
    });
  } catch {
    return false;
  }

  return derived.length === key.length && timingSafeEqual(derived, key);
}

/** True when `encoded` was produced with weaker parameters than today's default. */
export function needsRehash(encoded: string): boolean {
  const parsed = parseEncoded(encoded);
  if (!parsed) return true;
  return parsed.N < DEFAULT_PARAMS.N || parsed.r < DEFAULT_PARAMS.r || parsed.p < DEFAULT_PARAMS.p;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parseEncoded(encoded: string): ParsedHash | null {
  const parts = encoded.split('$');
  if (parts.length !== 6) return null;
  const [scheme, rawN, rawR, rawP, rawSalt, rawKey] = parts;
  if (scheme !== 'scrypt') return null;

  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!isPositiveInt(N) || !isPositiveInt(r) || !isPositiveInt(p)) return null;
  // N must be a power of two greater than 1, or scrypt rejects it.
  if ((N & (N - 1)) !== 0 || N < 2) return null;

  const salt = Buffer.from(rawSalt ?? '', 'base64');
  const key = Buffer.from(rawKey ?? '', 'base64');
  if (salt.length === 0 || key.length === 0) return null;

  return { N, r, p, salt, key };
}

const isPositiveInt = (value: number): boolean => Number.isInteger(value) && value > 0;

function assertPasswordLength(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new RangeError(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    // Unbounded input into a memory-hard KDF is a denial-of-service vector.
    throw new RangeError(`Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
}

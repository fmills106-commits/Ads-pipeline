import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Identifier generation.
 *
 * Primary keys are UUIDv4. Prefixed IDs (`ws_…`, `biz_…`) are used where an ID
 * is likely to be read by a human — logs, audit entries, support requests —
 * because a bare UUID gives no clue what it points at.
 */

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Crockford-ish base58: no 0/O/I/l, so IDs survive being read aloud. */
export function randomBase58(length: number): string {
  if (length < 1) throw new RangeError('length must be >= 1');
  // Rejection sampling keeps the distribution uniform; 58 does not divide 256.
  const limit = Math.floor(256 / BASE58.length) * BASE58.length;
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += BASE58[byte % BASE58.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export const uuid = (): string => randomUUID();

export type IdPrefix =
  'usr' | 'ws' | 'biz' | 'site' | 'prod' | 'camp' | 'crv' | 'exp' | 'job' | 'sess';

/** e.g. `biz_7Fk2Qp9WmZ`. */
export const prefixedId = (prefix: IdPrefix, length = 12): string =>
  `${prefix}_${randomBase58(length)}`;

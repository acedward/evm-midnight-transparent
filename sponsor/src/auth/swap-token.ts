// The swap's bearer token: 32 random bytes (base64url), issued by `POST /v1/swaps` and required by
// every other call of that swap as `Authorization: Bearer <token>`. The sponsor stores only its
// SHA-256, so its data directory never holds a usable credential; re-opening the swap issues a new
// token and the old one stops working.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const hashSwapToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

export function issueSwapToken(random: (n: number) => Uint8Array = (n) => randomBytes(n)): {
  token: string;
  hash: string;
} {
  const token = Buffer.from(random(32)).toString('base64url');
  return { token, hash: hashSwapToken(token) };
}

/** The bearer token of an `Authorization` header, or null. */
export function bearerOf(header: string | undefined | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+([A-Za-z0-9_-]{32,128})\s*$/.exec(header);
  return m ? m[1]! : null;
}

/** Constant-time comparison of a presented token with a stored hash. */
export function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashSwapToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

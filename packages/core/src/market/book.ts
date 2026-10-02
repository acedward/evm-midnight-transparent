// The live offers this app can swap, derived from the exchange's book with no token rules
// (owner: no special token; a pair is simply an offer's two legs).
//
// An offer is SWAPPABLE when:
//   - it has exactly one leg on each side (a basket cannot be bridged in one amount);
//   - both legs are SHIELDED (the temporary wallet uses its shielded sub-wallet only);
//   - both colours are tokens the vault bridges both ways (the registry), and they differ;
//   - neither amount is zero.
// Everything else is ignored, with a reason, and counted, never guessed at.
//
// Seen from the user: the offer WANTS token A (the user PAYS it, bridged in) and GIVES token B (the
// user RECEIVES it, bridged out). The price is an exact ratio of the two legs in whole tokens.
//
// Replaces MN Bank's USDC price derivation (acedward/passport-evm-dapp @ 911647b,
// packages/core/src/market/prices.ts), which priced every stock in USDC. All amounts are bigint
// base units and all prices exact rationals (`Ratio`); no floats.

import { type Ratio, priceRatio } from '../amount.js';
import type { TokenEntry, TokenRegistry } from '../tokens/registry.js';
import type { OfferLeg } from './wire.js';

/** The fields of an offer the derivation reads (an `OfferRow` has them). */
export interface BookOfferInput {
  offerId: string;
  computed: {
    gives: readonly OfferLeg[];
    wants: readonly OfferLeg[];
    expiresAt?: string | null;
    firstSeenAt?: string | null;
  };
}

export const IGNORE_REASONS = [
  /** a side with no leg */
  'one-sided',
  /** more than one leg on a side */
  'basket',
  /** a leg that is not SHIELDED */
  'unshielded',
  /** a colour the vault does not bridge */
  'not-bridgeable',
  /** the same colour both ways */
  'same-token',
  /** a zero amount */
  'zero-amount',
  /** the same offer id twice */
  'duplicate',
] as const;
export type IgnoreReason = (typeof IGNORE_REASONS)[number];

export interface SwapLeg {
  token: TokenEntry;
  /** Base units of `token`. */
  amount: bigint;
}

export interface SwapOffer {
  offerId: string;
  /** What the user pays: the offer's WANTED leg, bridged in. */
  pay: SwapLeg;
  /** What the user receives: the offer's GIVEN leg, bridged out. */
  receive: SwapLeg;
  /** Whole `pay` tokens per whole `receive` token. */
  price: Ratio;
  /** ISO time the offer expires, as the kernel reports it (null when unknown). */
  expiresAt: string | null;
  firstSeenAt: string | null;
}

export type Classified = { kind: 'swappable'; offer: SwapOffer } | { kind: 'ignored'; reason: IgnoreReason };

/** Reduce a ratio by its greatest common divisor (display and comparison stay exact). */
export function reduce(r: Ratio): Ratio {
  let a = r.num < 0n ? -r.num : r.num;
  let b = r.den;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? { num: 0n, den: 1n } : { num: r.num / a, den: r.den / a };
}

/** Classify one live offer against the registry. */
export function classifyOffer(offer: BookOfferInput, registry: TokenRegistry): Classified {
  const { gives, wants } = offer.computed;
  if (gives.length === 0 || wants.length === 0) return { kind: 'ignored', reason: 'one-sided' };
  if (gives.length > 1 || wants.length > 1) return { kind: 'ignored', reason: 'basket' };
  const give = gives[0]!;
  const want = wants[0]!;
  if (give.type !== 'SHIELDED' || want.type !== 'SHIELDED') return { kind: 'ignored', reason: 'unshielded' };
  if (!registry.isBridgeable(give.token) || !registry.isBridgeable(want.token))
    return { kind: 'ignored', reason: 'not-bridgeable' };
  const receiveToken = registry.byColour(give.token)!;
  const payToken = registry.byColour(want.token)!;
  if (receiveToken === payToken) return { kind: 'ignored', reason: 'same-token' };
  if (give.amount <= 0n || want.amount <= 0n) return { kind: 'ignored', reason: 'zero-amount' };
  return {
    kind: 'swappable',
    offer: {
      offerId: offer.offerId,
      pay: { token: payToken, amount: want.amount },
      receive: { token: receiveToken, amount: give.amount },
      price: reduce(priceRatio(want.amount, payToken.decimals, give.amount, receiveToken.decimals)),
      expiresAt: offer.computed.expiresAt ?? null,
      firstSeenAt: offer.computed.firstSeenAt ?? null,
    },
  };
}

export interface BookSnapshot {
  /** Every swappable offer, in the order the kernel served them (newest first). */
  offers: SwapOffer[];
  /** How many live offers were not swappable, by reason. */
  ignored: Record<IgnoreReason, number>;
}

/** The swappable offers of a book, and a count of the rest. */
export function deriveBook(offers: readonly BookOfferInput[], registry: TokenRegistry): BookSnapshot {
  const ignored = Object.fromEntries(IGNORE_REASONS.map((r) => [r, 0])) as Record<IgnoreReason, number>;
  const seen = new Set<string>();
  const out: SwapOffer[] = [];
  for (const o of offers) {
    if (seen.has(o.offerId)) {
      ignored.duplicate++;
      continue;
    }
    seen.add(o.offerId);
    const c = classifyOffer(o, registry);
    if (c.kind === 'swappable') out.push(c.offer);
    else ignored[c.reason]++;
  }
  return { offers: out, ignored };
}

/** Milliseconds until the offer expires (negative once it has), or null when the kernel gave no
 *  readable expiry. The swap page decides how much time a swap needs. */
export function timeToExpiryMs(offer: Pick<SwapOffer, 'expiresAt'>, nowMs: number): number | null {
  if (offer.expiresAt === null) return null;
  const at = Date.parse(offer.expiresAt);
  return Number.isNaN(at) ? null : at - nowMs;
}

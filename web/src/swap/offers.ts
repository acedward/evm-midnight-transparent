// The offers list: every live offer whose two legs are vault tokens (core's book, `deriveBook`),
// minus the ones that expire before a swap could finish. No token rules: a row is simply "you pay
// the offer's wanted leg, you receive its given leg" (owner: no special token).
//
// A swap takes about 20 minutes (the bridge-in waits for Sepolia finality and the MPC attestation,
// about 18 minutes), so an offer that expires within 45 minutes is not offered.

import {
  type BookSnapshot,
  type Ratio,
  type SwapOffer,
  compareRatio,
  formatUnits,
  timeToExpiryMs,
} from '@evm-midnight-transparent/core';

/** An offer must stay live at least this long to be listed. */
export const MIN_TIME_TO_EXPIRY_MS = 45 * 60_000;
/** What the page tells the user a swap takes. */
export const BRIDGE_IN_ESTIMATE_MIN = 18;
export const SWAP_ESTIMATE_MIN = 20;

export interface ListedOffers {
  offers: SwapOffer[];
  /** Live, swappable offers left out because they expire within `MIN_TIME_TO_EXPIRY_MS`. */
  expiringSoon: number;
}

/** Whether the offer is listed: no known expiry, or one more than 45 minutes out. */
export function lastsLongEnough(offer: Pick<SwapOffer, 'expiresAt'>, nowMs: number): boolean {
  const left = timeToExpiryMs(offer, nowMs);
  return left === null || left > MIN_TIME_TO_EXPIRY_MS;
}

const pairKey = (o: SwapOffer) => `${o.pay.token.midnightName}\u0000${o.receive.token.midnightName}`;

/** The rows of the list, grouped by what you pay and receive, the lowest price (best for you) first. */
export function listOffers(snapshot: BookSnapshot, nowMs: number): ListedOffers {
  const offers: SwapOffer[] = [];
  let expiringSoon = 0;
  for (const o of snapshot.offers) {
    if (lastsLongEnough(o, nowMs)) offers.push(o);
    else expiringSoon++;
  }
  offers.sort((a, b) => {
    const k = pairKey(a) < pairKey(b) ? -1 : pairKey(a) > pairKey(b) ? 1 : 0;
    if (k !== 0) return k;
    const p = compareRatio(a.price, b.price);
    return p !== 0 ? p : a.offerId < b.offerId ? -1 : 1;
  });
  return { offers, expiringSoon };
}

/** An exact ratio as a short decimal: six decimals above 1, four significant digits below. */
export function formatPriceRatio(r: Ratio): string {
  if (r.den <= 0n) return '—';
  if (r.num === 0n) return '0';
  const whole = r.num / r.den;
  let digits = 6;
  if (whole === 0n) {
    // Leading zeros after the point, then four significant digits.
    let zeros = 0;
    let x = r.num * 10n;
    while (x < r.den && zeros < 18) {
      x *= 10n;
      zeros++;
    }
    digits = Math.min(zeros + 4, 24);
  }
  const scaled = (r.num * 10n ** BigInt(digits)) / r.den;
  const text = formatUnits(scaled, digits, { grouping: true });
  return text.includes('.') ? text : `${text}.00`;
}

/** The ratio the other way round (whole receive tokens per whole pay token). */
export const invert = (r: Ratio): Ratio => ({ num: r.den, den: r.num });

/** "in 13 d 4 h", "in 2 h 5 min", "in 50 min", "expired". */
export function formatTimeLeft(ms: number | null): string {
  if (ms === null) return 'no expiry given';
  if (ms <= 0) return 'expired';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h} h ${min % 60} min`;
  return `in ${Math.floor(h / 24)} d ${h % 24} h`;
}

/** The expiry as UTC text, for the row's title. */
export const formatUtc = (iso: string | null): string =>
  iso === null || Number.isNaN(Date.parse(iso))
    ? '—'
    : `${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

// The swappable offers of a book: no token rules (a pair is the offer's two legs), only what the
// vault and the temporary wallet can carry. Expected values are written out by hand.

import { describe, expect, it } from 'vitest';

import {
  type OfferRow,
  classifyOffer,
  deriveBook,
  formatRatio,
  stagenetRegistry,
  timeToExpiryMs,
} from '../src/index.js';
import { BOOK, COLOUR, leg, offerRow } from './fixtures/kernel/book.js';

const registry = stagenetRegistry();
/** A wire row as the kernel client parses it (amounts as bigints). */
const parsed = (o: (typeof BOOK)[number]): OfferRow => ({
  offerId: o.offerId,
  blockHeight: o.blockHeight,
  blobChars: o.blobChars,
  computed: {
    gives: o.computed.gives.map((l) => ({ ...l, amount: BigInt(l.amount) })),
    wants: o.computed.wants.map((l) => ({ ...l, amount: BigInt(l.amount) })),
    expiresAt: o.computed.expiresAt,
    firstSeenAt: o.computed.firstSeenAt,
    status: o.computed.status,
  },
});
const TBILL = '05b32284398b1a75dac4f92dcb8802a57ce2194dd3cae781f870430c18a8a8e9';

describe('classifyOffer', () => {
  it('reads an offer from the user side: pay what it wants, receive what it gives', () => {
    // The maker gives 10 wStkA and wants 10.5 wUSDC.
    const c = classifyOffer(
      parsed(offerRow(1, [leg(COLOUR.wStkA, 10_000_000)], [leg(COLOUR.wUSDC, 10_500_000)])),
      registry,
    );
    expect(c.kind).toBe('swappable');
    if (c.kind !== 'swappable') return;
    expect(c.offer.pay.token.midnightName).toBe('wUSDC');
    expect(c.offer.pay.amount).toBe(10_500_000n);
    expect(c.offer.receive.token.midnightName).toBe('wStkA');
    expect(c.offer.receive.amount).toBe(10_000_000n);
    expect(formatRatio(c.offer.price, 2)).toBe('1.05'); // wUSDC per wStkA
    expect(c.offer.price).toEqual({ num: 21n, den: 20n });
  });

  it('has no token rules: any two different bridgeable tokens make a pair', () => {
    const stockToStock = classifyOffer(
      parsed(offerRow(2, [leg(COLOUR.wStkA, 5_000_000)], [leg(COLOUR.wStkB, 5_000_000)])),
      registry,
    );
    expect(stockToStock.kind).toBe('swappable');
    const tbill = classifyOffer(
      parsed(offerRow(3, [leg(TBILL, 2_000_000)], [leg(COLOUR.wStkC, 300_000_000)])),
      registry,
    );
    expect(tbill.kind === 'swappable' && formatRatio(tbill.offer.price, 0)).toBe('150'); // wStkC per TBILL
  });

  it('ignores what the vault or the temporary wallet cannot carry, with the reason', () => {
    const reason = (gives: ReturnType<typeof leg>[], wants: ReturnType<typeof leg>[]) => {
      const c = classifyOffer(parsed(offerRow(9, gives, wants)), registry);
      return c.kind === 'ignored' ? c.reason : 'swappable';
    };
    expect(reason([], [leg(COLOUR.wUSDC, 1)])).toBe('one-sided');
    expect(reason([leg(COLOUR.wStkA, 1), leg(COLOUR.wStkB, 1)], [leg(COLOUR.wUSDC, 2)])).toBe('basket');
    expect(reason([leg(COLOUR.wStkA, 1)], [leg(COLOUR.wUSDC, 1, 'UNSHIELDED')])).toBe('unshielded');
    expect(reason([leg(COLOUR.wStkA, 1)], [leg(COLOUR.TWUSDC, 1)])).toBe('not-bridgeable');
    expect(reason([leg(COLOUR.NIGHT, 1)], [leg(COLOUR.wUSDC, 1)])).toBe('not-bridgeable');
    expect(reason([leg(COLOUR.wStkA, 1)], [leg(COLOUR.wStkA, 2)])).toBe('same-token');
    expect(reason([leg(COLOUR.wStkA, 0)], [leg(COLOUR.wUSDC, 1)])).toBe('zero-amount');
  });
});

describe('deriveBook', () => {
  it('keeps the 7 swappable offers of the scenario book, newest first, and counts the rest', () => {
    const s = deriveBook(BOOK.map(parsed), registry);
    // BOOK is newest first: offers 11 … 1. Offers 8–11 are ignored.
    expect(s.offers.map((o) => o.offerId)).toEqual([7, 6, 5, 4, 3, 2, 1].map((n) => offerRow(n, [], []).offerId));
    expect(s.ignored).toEqual({
      'one-sided': 0,
      basket: 1,
      unshielded: 2,
      'not-bridgeable': 1,
      'same-token': 0,
      'zero-amount': 0,
      duplicate: 0,
    });
    const prices = Object.fromEntries(
      s.offers.map((o) => [
        `${o.pay.token.midnightName}->${o.receive.token.midnightName} ${o.offerId.slice(-1)}`,
        formatRatio(o.price, 4),
      ]),
    );
    expect(prices).toEqual({
      'wUSDC->wStkA 1': '1.0500', // pay 10.5 wUSDC, receive 10 wStkA
      'wStkA->wUSDC 2': '1.0526', // pay 10 wStkA, receive 9.5 wUSDC: 20/19
      'wUSDC->wStkA 3': '1.1000',
      'wStkA->wUSDC 4': '1.1111', // 10/9
      'wUSDC->wStkC 5': '0.0104',
      'wUSDC->wStkC 6': '0.0120',
      'wStkB->wStkA 7': '1.0000',
    });
  });

  it('counts a repeated offer id once', () => {
    const row = parsed(BOOK[BOOK.length - 1]!);
    const s = deriveBook([row, row], registry);
    expect(s.offers).toHaveLength(1);
    expect(s.ignored.duplicate).toBe(1);
  });
});

describe('timeToExpiryMs', () => {
  it('is the time left, negative once expired, null when unknown', () => {
    const at = Date.parse('2026-10-11T12:00:00.000Z');
    expect(timeToExpiryMs({ expiresAt: '2026-10-11T12:00:00.000Z' }, at - 45 * 60_000)).toBe(45 * 60_000);
    expect(timeToExpiryMs({ expiresAt: '2026-10-11T12:00:00.000Z' }, at + 1)).toBe(-1);
    expect(timeToExpiryMs({ expiresAt: null }, at)).toBeNull();
    expect(timeToExpiryMs({ expiresAt: 'soon' }, at)).toBeNull();
  });
});

// The mock world the mock ports share, in the page's memory: the exchange's offer book, the
// temporary wallets' shielded coins, and a counter for fake transaction hashes. The mock kernel reads
// the book, the mock wallet holds coins here, the mock sponsor mints and burns them. Nothing here is
// real and nothing leaves the page.

import { type TokenRegistry, parseUnits } from '@evm-midnight-transparent/core';
import { keccak256, toUtf8Bytes } from 'ethers';

export type MockOfferStatus = 'live' | 'consumed' | 'expired';

export interface MockLeg {
  token: string;
  amount: bigint;
  type: 'SHIELDED' | 'UNSHIELDED';
}

export interface MockOffer {
  offerId: string;
  gives: MockLeg[];
  wants: MockLeg[];
  expiresAt: string;
  firstSeenAt: string;
  blockHeight: number;
  status: MockOfferStatus;
}

export interface MockChainEvent {
  type: 'offer_indexed' | 'offer_consumed' | 'offer_expired';
  offerHash: string;
  timestamp: number;
}

const hash = (label: string) => keccak256(toUtf8Bytes(label)).slice(2);

type DumpLeg = Omit<MockLeg, 'amount'> & { amount: string };

export interface MockChainDump {
  offers: Array<Omit<MockOffer, 'gives' | 'wants'> & { gives: DumpLeg[]; wants: DumpLeg[] }>;
  coins: Array<[string, Array<[string, string]>]>;
  takes: Array<[string, string]>;
  counter: number;
  height: number;
}

export class MockChainError extends Error {
  override name = 'MockChainError';
}

export class MockChain {
  readonly offers = new Map<string, MockOffer>();
  private readonly coins = new Map<string, Map<string, bigint>>();
  private readonly listeners = new Set<(ev: MockChainEvent) => void>();
  private counter = 0;
  private height = 700_000;

  constructor(
    readonly registry: TokenRegistry,
    readonly now: () => number = Date.now,
  ) {}

  // ── the book ───────────────────────────────────────────────────────────

  subscribe(listener: (ev: MockChainEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(type: MockChainEvent['type'], offerId: string): void {
    const ev = { type, offerHash: offerId, timestamp: this.now() };
    for (const l of [...this.listeners]) l(ev);
  }

  /** A colour by the token's Midnight name (wStkA, wUSDC, …). */
  colour(midnightName: string): string {
    const t = this.registry.byMidnightName(midnightName);
    if (!t) throw new MockChainError(`no token ${midnightName} in the registry`);
    return t.midnightColour;
  }

  addOffer(label: string, gives: MockLeg[], wants: MockLeg[], expiresInMs: number): string {
    const offerId = hash(`emt-mock-offer:${label}`);
    this.offers.set(offerId, {
      offerId,
      gives,
      wants,
      expiresAt: new Date(this.now() + expiresInMs).toISOString(),
      firstSeenAt: new Date(this.now() - 60_000 * (this.offers.size + 1)).toISOString(),
      blockHeight: ++this.height,
      status: 'live',
    });
    this.emit('offer_indexed', offerId);
    return offerId;
  }

  offer(offerId: string): MockOffer | undefined {
    return this.offers.get(offerId.replace(/^0x/, '').toLowerCase());
  }

  liveOffers(): MockOffer[] {
    return [...this.offers.values()].filter((o) => o.status === 'live').sort((a, b) => b.blockHeight - a.blockHeight);
  }

  /** The offer is taken (by us or by someone else): gone from the book for good. */
  consume(offerId: string): void {
    const o = this.offer(offerId);
    if (!o || o.status !== 'live') return;
    o.status = 'consumed';
    this.emit('offer_consumed', o.offerId);
  }

  /** The maker's offer as the kernel serves it in `offerBech32` (mock text, not MIP-0005). */
  static offerBech32(offerId: string): string {
    return `swapoffer1mock${offerId}`;
  }

  static offerIdOfBech32(text: string): string | null {
    const m = /^swapoffer1mock([0-9a-f]{64})$/.exec(text);
    return m ? m[1]! : null;
  }

  /** The stagenet ladders' shape: wStk ↔ wUSDC bids and asks at cent prices, one pair without
   *  wUSDC, a T-bill offer, one offer expiring within 45 minutes, and three the app cannot swap. */
  seedDefaultBook(): void {
    const S = (name: string, whole: string): MockLeg => ({
      token: this.colour(name),
      amount: parseUnits(whole, this.registry.byMidnightName(name)!.decimals),
      type: 'SHIELDED',
    });
    const day = 86_400_000;
    this.addOffer('bid-a-104', [S('wUSDC', '1')], [S('wStkA', '104.166667')], 13 * day);
    this.addOffer('bid-a-108', [S('wUSDC', '1')], [S('wStkA', '108.695653')], 13 * day);
    this.addOffer('ask-a-104', [S('wStkA', '100')], [S('wUSDC', '1.04')], 12 * day);
    this.addOffer('ask-a-108', [S('wStkA', '100')], [S('wUSDC', '1.08')], 12 * day);
    this.addOffer('ask-b-125', [S('wStkB', '100')], [S('wUSDC', '1.25')], 11 * day);
    this.addOffer('bid-b-80', [S('wUSDC', '1')], [S('wStkB', '80')], 11 * day);
    this.addOffer('a-for-b', [S('wStkA', '5')], [S('wStkB', '5')], 3 * day);
    this.addOffer('tbill', [S('TBILL', '10')], [S('wUSDC', '9.9')], 2 * day);
    // Expires within 45 minutes: live, swappable, not listed.
    this.addOffer('soon', [S('wUSDC', '1')], [S('wStkA', '120')], 30 * 60_000);
    // Not swappable: an unshielded leg, a colour the vault does not bridge, a basket.
    this.addOffer('unshielded', [{ ...S('wStkA', '1'), type: 'UNSHIELDED' }], [S('wUSDC', '1')], 5 * day);
    this.addOffer(
      'foreign',
      [{ token: 'e9'.repeat(32), amount: 1_000_000n, type: 'SHIELDED' }],
      [S('wUSDC', '1')],
      5 * day,
    );
    this.addOffer('basket', [S('wStkA', '1'), S('wStkB', '1')], [S('wUSDC', '2')], 5 * day);
  }

  // ── coins ──────────────────────────────────────────────────────────────

  balances(coinPk: string): Map<string, bigint> {
    return new Map(this.coins.get(coinPk) ?? []);
  }

  mint(coinPk: string, colour: string, amount: bigint): void {
    const m = this.coins.get(coinPk) ?? new Map<string, bigint>();
    m.set(colour, (m.get(colour) ?? 0n) + amount);
    this.coins.set(coinPk, m);
  }

  burn(coinPk: string, colour: string, amount: bigint): void {
    const m = this.coins.get(coinPk);
    const have = m?.get(colour) ?? 0n;
    if (!m || have < amount) throw new MockChainError('the temporary wallet does not hold that coin');
    if (have === amount) m.delete(colour);
    else m.set(colour, have - amount);
  }

  /** The drafts whose coin a landed transaction spent (a take the batcher took, a withdrawal the
   *  sponsor started): the mock wallet's sync then drops their booking, as the real wallet drops a
   *  pending spend once it sees the coin's nullifier on chain (P4.2-fix2 R3, F-B24). In memory only:
   *  a reload makes new wallets, which book nothing. */
  private readonly spentDrafts = new Set<string>();

  markSpent(draftId: string | undefined): void {
    if (draftId) this.spentDrafts.add(draftId);
  }

  isSpent(draftId: string): boolean {
    return this.spentDrafts.has(draftId);
  }

  private readonly takes = new Map<string, string>();

  /** The take a temporary wallet landed (the mock sponsor reports it as `takeTx`). */
  recordTake(coinPk: string, txHash: string): void {
    this.takes.set(coinPk, txHash);
  }

  lastTake(coinPk: string): string | null {
    return this.takes.get(coinPk) ?? null;
  }

  // ── persistence (mock mode keeps its world across a reload or a new tab) ──

  dump(): MockChainDump {
    const legs = (ls: MockLeg[]) => ls.map((l) => ({ ...l, amount: l.amount.toString() }));
    return {
      offers: [...this.offers.values()].map((o) => ({ ...o, gives: legs(o.gives), wants: legs(o.wants) })),
      coins: [...this.coins].map(([pk, m]) => [pk, [...m].map(([c, v]) => [c, v.toString()])]),
      takes: [...this.takes],
      counter: this.counter,
      height: this.height,
    };
  }

  restore(d: MockChainDump): void {
    const legs = (ls: MockChainDump['offers'][number]['gives']) => ls.map((l) => ({ ...l, amount: BigInt(l.amount) }));
    this.offers.clear();
    for (const o of d.offers) this.offers.set(o.offerId, { ...o, gives: legs(o.gives), wants: legs(o.wants) });
    this.coins.clear();
    for (const [pk, m] of d.coins) this.coins.set(pk, new Map(m.map(([c, v]) => [c, BigInt(v)])));
    this.takes.clear();
    for (const [pk, h] of d.takes) this.takes.set(pk, h);
    this.counter = d.counter;
    this.height = d.height;
  }

  // ── hashes ─────────────────────────────────────────────────────────────

  /** A fresh fake 32-byte hash (64 hex), unique per call. */
  newHash(label: string): string {
    return hash(`emt-mock:${label}:${++this.counter}`);
  }
}

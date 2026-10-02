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

/** An ERC20 transfer the mock bridge made on its fake Sepolia (a withdrawal paying the user), as a
 *  mined transaction: what `eth_getTransactionReceipt` answers for it (P4.2-fix4). */
export interface MockSepoliaTransfer {
  /** 0x + 64 hex. */
  hash: string;
  /** The ERC20 contract that emitted the `Transfer` log. */
  token: string;
  from: string;
  to: string;
  /** Base units (decimal). */
  amount: string;
  /** The receipt's status: 1 mined and executed, 0 reverted (then no log). */
  status: 0 | 1;
  blockNumber: number;
}

/** The `Transfer(address,address,uint256)` event's topic. */
const TRANSFER_TOPIC = keccak256(toUtf8Bytes('Transfer(address,address,uint256)'));
const word = (hex: string) => `0x${hex.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

/** The fake Sepolia's first block for the bridge's transfers: above every block the specs' and the
 *  mock EVM wallets' own transactions are mined in (they count from 5,000,000), as the real
 *  withdrawal comes long after the user funded the swap. */
export const MOCK_SEPOLIA_BRIDGE_BLOCK = 6_000_000;

export interface MockChainDump {
  offers: Array<Omit<MockOffer, 'gives' | 'wants'> & { gives: DumpLeg[]; wants: DumpLeg[] }>;
  coins: Array<[string, Array<[string, string]>]>;
  takes: Array<[string, string]>;
  counter: number;
  height: number;
  /** Absent in a world saved before P4.2-fix4. */
  sepolia?: { transfers: MockSepoliaTransfer[]; block: number };
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

  // ── the fake Sepolia's bridge transfers (P4.2-fix4) ─────────────────────

  private readonly transfers = new Map<string, MockSepoliaTransfer>();
  private sepoliaBlock = MOCK_SEPOLIA_BRIDGE_BLOCK;

  /** The bridge's ERC20 transfer, mined on the fake Sepolia (`blockNumber`: the next block unless
   *  given). Returns its hash. */
  mineSepoliaTransfer(t: Omit<MockSepoliaTransfer, 'hash' | 'blockNumber'> & { blockNumber?: number }): string {
    const h = `0x${this.newHash('sepolia-transfer')}`;
    this.transfers.set(h, { ...t, hash: h, blockNumber: t.blockNumber ?? ++this.sepoliaBlock });
    return h;
  }

  /** The receipt of a bridge transfer, shaped as `eth_getTransactionReceipt` answers it (hex
   *  quantities, the ERC20 `Transfer` log when it executed); null for a hash it did not mine. */
  sepoliaReceipt(txHash: string): Record<string, unknown> | null {
    const t = this.transfers.get(txHash.toLowerCase());
    if (!t) return null;
    return {
      transactionHash: t.hash,
      blockNumber: `0x${t.blockNumber.toString(16)}`,
      status: t.status === 1 ? '0x1' : '0x0',
      from: t.from.toLowerCase(),
      to: t.token.toLowerCase(),
      logs:
        t.status === 1
          ? [
              {
                address: t.token.toLowerCase(),
                topics: [TRANSFER_TOPIC, word(t.from), word(t.to)],
                data: word(BigInt(t.amount).toString(16)),
                logIndex: '0x0',
                transactionHash: t.hash,
              },
            ]
          : [],
    };
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
      sepolia: { transfers: [...this.transfers.values()], block: this.sepoliaBlock },
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
    this.transfers.clear();
    for (const t of d.sepolia?.transfers ?? []) this.transfers.set(t.hash, { ...t });
    this.sepoliaBlock = d.sepolia?.block ?? MOCK_SEPOLIA_BRIDGE_BLOCK;
  }

  // ── hashes ─────────────────────────────────────────────────────────────

  /** A fresh fake 32-byte hash (64 hex), unique per call. */
  newHash(label: string): string {
    return hash(`emt-mock:${label}:${++this.counter}`);
  }
}

// The swap service: every rule of the sponsor's swap API (plan 00048 "Lane contracts"; spec US1–US3).
//
// OPEN. One EIP-712 signature by the user's EVM address (verified by the route) opens a swap for one
// live offer: the offer must be live, expire at least `minOfferTtlSeconds` ahead, have exactly the
// request's pay and receive legs (both shielded vault tokens, different colours) in its kernel view
// AND in its maker transaction's own imbalances. The sponsor computes the deposit address from the
// temporary coin public key and sizes the sweep gas (./sweep-gas.ts). Re-opening a known swap id with
// the same owner, terms and keys is a resume: a new bearer token, no offer check (funds may be on
// the way).
//
// DEPOSIT (server-driven). A poll watches every `awaiting_funds` swap's deposit address; once it holds
// at least the pay amount of the ERC20 and the sweep ETH, the sponsor (its own wallet paying) submits
// `startDeposit` (recipient = the temporary coin public key; the sweep's gas as fixed at open), runs
// the relayer (the MPC signs the sweep, it is broadcast, Sepolia finality, the attestation) and
// submits `completeDeposit` with the temporary encryption key mapped, so the coin is sealed to the
// temporary wallet. A sweep attested never-executed is abandoned (`abandonDeposit`) and retried while
// the funds are still there (at most `maxDepositAttempts` starts).
//
// PROVE. The sponsor proves with its own proof server and key directory, but only a take of THIS
// swap's offer, or THIS swap's `startWithdraw` (../validate/rules.ts), within a per-swap budget.
//
// WITHDRAW. The browser's proven, bound `startWithdraw` (the same calls its latest `/prove withdraw`
// validated) waits for the ONE withdrawal lane: every withdrawal is paid from the vault's single EVM
// account, so its nonce orders them. At the head of the lane the sponsor re-checks the nonce (the
// account's pending one) and the calls against the vault's live state, adds DUST, submits, and holds
// the lane until the MPC-signed transfer is broadcast (or refused), so no two starts share a nonce.
// Then the attestation and `completeWithdraw` (or `refundWithdraw`) run outside the lane. A refund
// (the transfer did not happen, e.g. a nonce taken by another service, plan Q9 A) returns the swap to
// `minted`; the app rebuilds and retries. The same path serves Bridge back (the paid token).
//
// RESTARTS. Every step is persisted before and after it runs (./store.ts). At start-up the service
// resumes every swap in flight from its recorded request id (the relayer loop is resumable).

import {
  BRIDGE_ERRORS,
  SWAP_ERRORS,
  depositPreflight,
  withdrawPreflight,
  type EvmGasPolicy,
  type OpenSwapPayload,
  type ProveRequest,
  type SwapState,
  type TakeReport,
  type TokenEntry,
  type TokenRegistry,
  type WithdrawKind,
  type WithdrawParams,
} from '@evm-midnight-transparent/core';
import { getAddress } from 'ethers';

import { issueSwapToken, tokenMatches } from '../auth/swap-token.js';
import type { SponsorConfig } from '../config.js';
import type { Logger } from '../log.js';
import { FifoLock } from '../queue/fifo-lock.js';
import type { SponsorStatus } from '../sponsor/session.js';
import { InvalidTxError, validateTake, validateWithdraw } from '../validate/rules.js';
import type { TxSummary } from '../validate/summary.js';
import type {
  Attestation,
  MidnightTxFacts,
  OfferReader,
  RelayOutcome,
  RelayProgress,
  SwapBackend,
  SwapProver,
} from './backend.js';
import { DriveError, SwapError } from './errors.js';
import {
  WALLET_HOLDS_FUNDS,
  currentWithdrawal,
  isTerminal,
  pushStage,
  transition,
  type DepositRecord,
  type LegRecord,
  type SwapRecord,
  type WithdrawRecord,
} from './model.js';
import type { SwapStore } from './store.js';
import { sizeSweepGas } from './sweep-gas.js';

/** The MPC signature budget, counted from the start (upstream `POLL_TIMEOUT_MS`). */
export const MPC_SIGNATURE_BUDGET_MS = 20 * 60_000;
/** How far past the lane's next nonce a `/prove withdraw` may name (audit F-A15). */
export const MAX_EVM_NONCE_AHEAD = 2n;
const DAY_MS = 86_400_000;

export interface SwapServiceConfig {
  network: string;
  tokens: TokenRegistry;
  /** The gas fields a withdrawal signs (the vault's EVM account pays them). */
  bridgeGas: EvmGasPolicy;
  sweepGasLimits: Readonly<Record<string, bigint>>;
  /** Refuse to open a swap whose sweep would need more ETH than this (a gas spike). */
  maxSweepWei: bigint;
  minOfferTtlSeconds: number;
  maxActiveSwapsPerOwner: number;
  /** New swaps per EVM address in any 24 hours (audit C7). */
  maxSwapsPerOwnerPerDay: number;
  /** Swaps waiting for funds that have received nothing, all addresses together (audit C6). */
  maxUnfundedSwaps: number;
  /** Proofs per swap and purpose (the withdraw budget renews for each new attempt). */
  proofsPerSwap: number;
  /** Every proof of one swap together, over its whole life. */
  proofsTotalPerSwap: number;
  depositPollMs: number;
  /** How often one unfunded deposit address is read: every pass for the first 10 minutes (and once
   *  any of the token arrived), then every `medium`, and after an hour every `slow` (audit C6). */
  pollBackoffMs: { fast: number; medium: number; slow: number };
  /** An `awaiting_funds` swap that received nothing fails after this long. */
  fundsWaitSeconds: number;
  /** ... one that received part of the token, after this long. */
  fundsWaitPartialSeconds: number;
  /** Never-funded failed swaps are dropped after this many days (their address read empty). */
  retainUnfundedDays: number;
  /** The sponsorship budget (audit C7): DUST per 24 h (0: none), per paid start, per paid settle. */
  dailyDustBudgetSpecks: bigint;
  dustPerStartSpecks: bigint;
  dustPerSettleSpecks: bigint;
  maxDepositAttempts: number;
  /** How often a re-open may re-arm a deposit that failed with its funds still at the address. */
  maxDepositRearms: number;
  /** Below this, the sponsor spends nothing new (specks). */
  dustLowSpecks: bigint;
}

/** The service's configuration from the sponsor's (main.ts and the tests share it). */
export function swapServiceConfig(c: SponsorConfig): SwapServiceConfig {
  return {
    network: c.network.name,
    tokens: c.tokens,
    bridgeGas: c.bridgeGas,
    sweepGasLimits: c.swaps.sweepGasLimits,
    maxSweepWei: c.swaps.maxSweepWei,
    minOfferTtlSeconds: c.swaps.minOfferTtlSeconds,
    maxActiveSwapsPerOwner: c.swaps.maxActivePerOwner,
    maxSwapsPerOwnerPerDay: c.swaps.maxPerOwnerPerDay,
    maxUnfundedSwaps: c.swaps.maxUnfunded,
    proofsPerSwap: c.swaps.proofsPerSwap,
    proofsTotalPerSwap: c.swaps.proofsTotalPerSwap,
    depositPollMs: c.swaps.depositPollSeconds * 1000,
    pollBackoffMs: { fast: c.swaps.depositPollSeconds * 1000, medium: 60_000, slow: 300_000 },
    fundsWaitSeconds: c.swaps.fundsWaitSeconds,
    fundsWaitPartialSeconds: c.swaps.fundsWaitPartialSeconds,
    retainUnfundedDays: c.swaps.retainUnfundedDays,
    dailyDustBudgetSpecks: c.swaps.dailyDustBudgetSpecks,
    dustPerStartSpecks: c.swaps.dustPerStartSpecks,
    dustPerSettleSpecks: c.swaps.dustPerSettleSpecks,
    maxDepositAttempts: c.swaps.maxDepositAttempts,
    maxDepositRearms: c.swaps.maxDepositRearms,
    dustLowSpecks: c.sponsor.dustLowSpecks,
  };
}

export interface SwapServiceDeps {
  config: SwapServiceConfig;
  store: SwapStore;
  /** The bridge, or null when this sponsor has none (no vault keys, no Sepolia RPC). */
  backend: () => SwapBackend | null;
  prover: () => SwapProver | null;
  offers: OfferReader;
  /** Read a transaction's structure (../validate/inspect.ts; a fake in tests). */
  inspect: (bytes: Uint8Array, stage: 'unproven' | 'final') => TxSummary;
  /** The segment-0 shielded imbalances of a maker's `swapoffer1…` transaction. */
  makerImbalances: (offerBech32: string) => Record<string, bigint>;
  sponsor: () => SponsorStatus;
  log: Logger;
  /** ms. */
  now?: () => number;
  random?: (n: number) => Uint8Array;
}

export interface BudgetStatus {
  dustSpentSpecks24h: string;
  dustBudgetSpecks24h: string;
  swapsOpened24h: number;
  unfundedOpen: number;
  unfundedMax: number;
  exhausted: boolean;
}

export interface MpcStatus {
  lastSignatureAfterSeconds: number | null;
  timeouts24h: number;
  inFlight: number;
}

const hexBytes = (hex: string): Uint8Array => {
  const h = hex.replace(/^0x/i, '');
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new SwapError(400, 'bad-request', 'tx is not hex');
  return Uint8Array.from(Buffer.from(h, 'hex'));
};

const isSignatureTimeout = (e: unknown) =>
  /timed out after \d+ s waiting for the MPC's signature/.test(e instanceof Error ? e.message : String(e));

export class SwapService {
  private readonly now: () => number;
  /** Background drives by swap id: one at a time per swap. */
  private readonly driving = new Map<string, Promise<void>>();
  /** Proofs one at a time: the proof server's memory, and the sponsor's own calls prove too. */
  readonly proverLane = new FifoLock();
  /** Withdrawal starts one at a time, until each one's Sepolia transfer is broadcast. */
  readonly withdrawalLane = new FifoLock();
  private laneNonce: { swapId: string; signedNonce: bigint; broadcast: boolean } | null = null;
  private readonly mpc = { lastSignatureAfterMs: null as number | null, timeouts: [] as number[] };
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  /** Opens between their checks and their record, so concurrent opens cannot pass the uniqueness
   *  and per-owner checks together (audit C11, F-B10). */
  private readonly admitting = {
    swaps: new Set<string>(),
    coins: new Set<string>(),
    owners: new Map<string, number>(),
  };
  /** When each awaiting deposit address is read next (ms; in memory: a restart reads them all once). */
  private readonly nextPoll = new Map<string, number>();
  private seq = 0;

  constructor(private readonly deps: SwapServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private get cfg() {
    return this.deps.config;
  }

  private nowS(): number {
    return Math.floor(this.now() / 1000);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Resume every swap in flight, then poll the deposit addresses. */
  start(): void {
    for (const rec of this.deps.store.all()) {
      if (rec.state === 'depositing') this.spawn(rec.swapId, () => this.driveDeposit(rec.swapId));
      if (rec.state === 'withdrawing' || rec.state === 'bridging_back') {
        this.spawn(rec.swapId, () => this.resumeWithdraw(rec.swapId));
      }
    }
    if (this.timer) return;
    void this.pollDeposits();
    this.timer = setInterval(() => void this.pollDeposits(), this.cfg.depositPollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolves when every background drive has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.driving.size > 0) await Promise.allSettled([...this.driving.values()]);
  }

  isDriving(swapId: string): boolean {
    return this.driving.has(swapId);
  }

  private spawn(swapId: string, fn: () => Promise<void>): boolean {
    if (this.driving.has(swapId)) return false;
    const run = fn()
      .catch((e: unknown) => this.deps.log.error('swap drive failed', { swapId, error: e }))
      .finally(() => this.driving.delete(swapId));
    this.driving.set(swapId, run);
    return true;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  /** The swap if `token` is its current bearer token; 401 otherwise (existence is not revealed). */
  authorize(swapId: string, token: string | null): SwapRecord {
    const rec = this.deps.store.get(swapId);
    if (!token || !rec || !tokenMatches(token, rec.tokenHash)) {
      throw new SwapError(401, 'unauthorised', 'this swap token is not valid (re-open the swap to get a new one)');
    }
    return rec;
  }

  countsByState(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.deps.store.all()) out[r.state] = (out[r.state] ?? 0) + 1;
    return out;
  }

  mpcStatus(): MpcStatus {
    const since = this.now() - DAY_MS;
    this.mpc.timeouts = this.mpc.timeouts.filter((t) => t > since);
    return {
      lastSignatureAfterSeconds:
        this.mpc.lastSignatureAfterMs === null ? null : Math.round(this.mpc.lastSignatureAfterMs / 1000),
      timeouts24h: this.mpc.timeouts.length,
      inFlight: this.driving.size,
    };
  }

  lanes(): Record<string, { running: number; waiting: number }> {
    return {
      prover: { running: this.proverLane.running, waiting: this.proverLane.waiting },
      withdrawal: { running: this.withdrawalLane.running, waiting: this.withdrawalLane.waiting },
      drives: { running: this.driving.size, waiting: 0 },
    };
  }

  // ── Open ──────────────────────────────────────────────────────────────────

  /** Whether `swapId` is known (a re-open, which spends nothing). */
  isKnown(swapId: string): boolean {
    return this.deps.store.get(swapId) !== undefined;
  }

  private token(colour: string): TokenEntry {
    const t = this.cfg.tokens.byColour(colour);
    if (!t || !this.cfg.tokens.isBridgeable(colour)) {
      throw new SwapError(422, SWAP_ERRORS.offerMismatch, 'the vault does not bridge this token', 'not-bridgeable');
    }
    return t;
  }

  private leg(t: TokenEntry, amount: string): LegRecord {
    return { colour: t.midnightColour, amount, symbol: t.symbol, erc20Address: t.sepoliaAddress, decimals: t.decimals };
  }

  /**
   * Open (or re-open) a swap. The route has verified the signature: `signer` signed `payload` for
   * `swapId`. Returns the new bearer token.
   */
  async open(input: {
    swapId: string;
    payload: OpenSwapPayload;
    signer: string;
  }): Promise<{ token: string; rec: SwapRecord; resumed: boolean }> {
    const { swapId, payload } = input;
    const owner = getAddress(input.signer);
    if (getAddress(payload.evmAddress) !== owner) {
      throw new SwapError(401, 'unauthorised', 'the swap’s EVM address is not the signer', 'wrong-signer');
    }
    const existing = this.deps.store.get(swapId);
    if (existing) return this.reopen(existing, payload, owner);
    if (this.admitting.swaps.has(swapId)) {
      throw new SwapError(409, SWAP_ERRORS.conflict, 'this swap is being opened right now', 'in-progress');
    }

    const pay = this.token(payload.pay.colour);
    const receive = this.token(payload.receive.colour);
    if (pay.midnightColour === receive.midnightColour) {
      throw new SwapError(422, SWAP_ERRORS.offerMismatch, 'a swap needs two different tokens', 'same-token');
    }
    if (this.deps.store.byCoinPk(payload.tempCoinPk) || this.admitting.coins.has(payload.tempCoinPk)) {
      throw new SwapError(409, SWAP_ERRORS.conflict, 'this temporary wallet already has a swap', 'coin-key-in-use');
    }
    const pendingOwner = this.admitting.owners.get(owner) ?? 0;
    const active =
      this.deps.store.all().filter((r) => r.evmAddress === owner && !isTerminal(r.state)).length + pendingOwner;
    if (active >= this.cfg.maxActiveSwapsPerOwner) {
      throw new SwapError(
        429,
        SWAP_ERRORS.tooManySwaps,
        `this address already has ${active} swaps in progress; finish one first`,
      );
    }
    // Spending controls for a NEW swap (re-opens are exempt): swaps per address per day, swaps
    // waiting for funds overall, and the daily DUST budget (audit C6, C7).
    const dayAgo = this.nowS() - 86_400;
    const today =
      this.deps.store.all().filter((r) => r.evmAddress === owner && r.createdAt > dayAgo).length + pendingOwner;
    if (today >= this.cfg.maxSwapsPerOwnerPerDay) {
      throw new SwapError(
        429,
        SWAP_ERRORS.tooManySwaps,
        `this address has started ${today} swaps in the last 24 hours; try again later`,
      );
    }
    if (this.unfundedCount() + this.admitting.swaps.size >= this.cfg.maxUnfundedSwaps) {
      throw new SwapError(
        503,
        SWAP_ERRORS.sponsorBusy,
        'too many swaps are waiting for funds right now; try again later',
      );
    }
    if (this.overBudget(this.admitting.swaps.size + 1)) {
      throw new SwapError(503, SWAP_ERRORS.sponsorBudget, 'the sponsor’s daily budget is spent; try again tomorrow');
    }
    const be = this.deps.backend();
    if (!be) throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'the sponsor cannot bridge right now');

    // Reserve the swap id, the coin key and an owner slot before the first await (atomic admission).
    this.admitting.swaps.add(swapId);
    this.admitting.coins.add(payload.tempCoinPk);
    this.admitting.owners.set(owner, (this.admitting.owners.get(owner) ?? 0) + 1);
    try {
      return await this.admit(swapId, payload, owner, pay, receive, be);
    } finally {
      this.admitting.swaps.delete(swapId);
      this.admitting.coins.delete(payload.tempCoinPk);
      const n = (this.admitting.owners.get(owner) ?? 1) - 1;
      if (n > 0) this.admitting.owners.set(owner, n);
      else this.admitting.owners.delete(owner);
    }
  }

  /** The awaited part of a new open, under the admission reservation. */
  private async admit(
    swapId: string,
    payload: OpenSwapPayload,
    owner: string,
    pay: TokenEntry,
    receive: TokenEntry,
    be: SwapBackend,
  ): Promise<{ token: string; rec: SwapRecord; resumed: boolean }> {
    await this.checkOffer(payload);

    let baseFee: bigint;
    try {
      baseFee = await be.evm.baseFeePerGas();
    } catch {
      throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'Sepolia cannot be read right now; try again shortly');
    }
    const gas = sizeSweepGas(pay.symbol, baseFee, this.cfg.sweepGasLimits);
    if (gas.ethWei > this.cfg.maxSweepWei) {
      throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'Sepolia gas is unusually expensive; try again later');
    }
    const now = this.nowS();
    const { token, hash } = issueSwapToken(this.deps.random);
    const rec: SwapRecord = {
      v: 1,
      swapId,
      evmAddress: owner,
      offerId: payload.offerId,
      pay: this.leg(pay, payload.pay.amount),
      receive: this.leg(receive, payload.receive.amount),
      tempCoinPk: payload.tempCoinPk,
      tempEncPk: payload.tempEncPk,
      depositAddress: be.depositAddress(payload.tempCoinPk),
      sweepGas: {
        gasLimit: gas.gasLimit.toString(),
        maxFeePerGas: gas.maxFeePerGas.toString(),
        maxPriorityFeePerGas: gas.maxPriorityFeePerGas.toString(),
        ethWei: gas.ethWei.toString(),
      },
      tokenHash: hash,
      state: 'awaiting_funds',
      deposit: { stage: 'waiting-for-funds', stages: [{ stage: 'waiting-for-funds', at: now }], attempts: 0 },
      takeTx: null,
      proofs: { take: 0, withdraw: 0 },
      provenWithdraw: null,
      withdrawals: [],
      history: [{ state: 'awaiting_funds', at: now }],
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.put(rec);
    this.deps.log.info('swap opened', { swapId, offerId: rec.offerId, pay: pay.symbol, receive: receive.symbol });
    return { token, rec, resumed: false };
  }

  private reopen(rec: SwapRecord, p: OpenSwapPayload, owner: string) {
    const same =
      rec.evmAddress === owner &&
      rec.offerId === p.offerId &&
      rec.tempCoinPk === p.tempCoinPk &&
      rec.tempEncPk === p.tempEncPk &&
      rec.pay.colour === p.pay.colour &&
      rec.pay.amount === p.pay.amount &&
      rec.receive.colour === p.receive.colour &&
      rec.receive.amount === p.receive.amount;
    if (!same) {
      throw new SwapError(409, SWAP_ERRORS.conflict, 'this swap id is open with other terms, keys or owner');
    }
    const { token, hash } = issueSwapToken(this.deps.random);
    rec.tokenHash = hash;
    const now = this.nowS();
    if (rec.state === 'failed' && rec.recoverable === true && rec.deposit) {
      // The funds wait at the deposit address (or have not arrived yet): wait again. After a failed
      // deposit, re-arm it: a NEW startDeposit to the same recipient moves them (audit C5).
      const d = rec.deposit;
      const rearm = rec.reason !== 'funds-not-received';
      // A re-armed deposit pays a new start and settle: it waits for the budget like a new swap.
      if (rearm && this.overBudget(1)) {
        this.deps.store.put(rec);
        this.deps.log.info('swap re-opened; re-arm deferred by the daily budget', { swapId: rec.swapId });
        return { token, rec, resumed: true };
      }
      if (rearm) {
        d.rearms = (d.rearms ?? 0) + 1;
        d.attempts = 0;
        delete d.requestId;
        delete d.startedAtMs;
      }
      transition(rec, 'awaiting_funds', now);
      pushStage(d, 'waiting-for-funds', now, { reopened: 'true', ...(rearm ? { rearm: String(d.rearms) } : {}) });
    }
    rec.updatedAt = now;
    this.nextPoll.delete(rec.swapId);
    this.deps.store.put(rec);
    this.deps.log.info('swap re-opened', { swapId: rec.swapId, state: rec.state });
    return { token, rec, resumed: true };
  }

  /** The offer is live, far enough from expiry, and exactly the request's two legs. */
  private async checkOffer(p: OpenSwapPayload): Promise<void> {
    let offer;
    try {
      offer = await this.deps.offers.offer(p.offerId);
    } catch {
      throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'the exchange cannot be read right now; try again');
    }
    if (!offer) throw new SwapError(409, SWAP_ERRORS.offerNotAvailable, 'the offer is not in the book', 'not-found');
    const status = offer.computed.status ?? 'unknown';
    if (status !== 'live') {
      throw new SwapError(409, SWAP_ERRORS.offerNotAvailable, `the offer is ${status}`, status);
    }
    const expiresAt = offer.computed.expiresAt ? Date.parse(offer.computed.expiresAt) : NaN;
    if (!Number.isFinite(expiresAt) || expiresAt < this.now() + this.cfg.minOfferTtlSeconds * 1000) {
      throw new SwapError(
        409,
        SWAP_ERRORS.offerNotAvailable,
        'the offer expires before a swap could finish',
        'expires-soon',
      );
    }
    const { gives, wants } = offer.computed;
    const one = (legs: readonly { token: string; amount: bigint; type: string }[]) =>
      legs.length === 1 && legs[0]!.type.toUpperCase() === 'SHIELDED' ? legs[0]! : null;
    const give = one(gives);
    const want = one(wants);
    const mismatch = (detail: string, message: string) =>
      new SwapError(422, SWAP_ERRORS.offerMismatch, message, detail);
    if (!give || !want) throw mismatch('legs', 'the offer is not one shielded token for another');
    if (give.token !== p.receive.colour || give.amount !== BigInt(p.receive.amount)) {
      throw mismatch('receive', 'the offer does not give what the swap receives');
    }
    if (want.token !== p.pay.colour || want.amount !== BigInt(p.pay.amount)) {
      throw mismatch('pay', 'the offer does not want what the swap pays');
    }
    let maker: Record<string, bigint>;
    try {
      maker = this.deps.makerImbalances(offer.offerBech32);
    } catch {
      throw mismatch('maker-tx', 'the offer’s transaction cannot be read');
    }
    const expected: Record<string, bigint> = {
      [p.receive.colour]: BigInt(p.receive.amount),
      [p.pay.colour]: -BigInt(p.pay.amount),
    };
    const keys = Object.keys(maker).filter((k) => maker[k] !== 0n);
    if (keys.length !== 2 || keys.some((k) => maker[k] !== expected[k])) {
      throw mismatch('maker-tx', 'the offer’s transaction is not the offer the book lists');
    }
  }

  // ── Spending controls (audit C6, C7) ──────────────────────────────────────

  /** A swap waiting for funds whose address has shown none of the token yet. */
  private static unfunded(r: SwapRecord): boolean {
    return r.state === 'awaiting_funds' && r.deposit?.seenAt === undefined;
  }

  private unfundedCount(): number {
    return this.deps.store.all().filter(SwapService.unfunded).length;
  }

  /** DUST (estimated per paid leg) the sponsor paid in the last 24 hours, from the recorded stages. */
  private spent24h(): bigint {
    const since = this.nowS() - 86_400;
    const { dustPerStartSpecks: start, dustPerSettleSpecks: settle } = this.cfg;
    let total = 0n;
    const add = (stages: readonly { stage: string; at: number }[], settles: readonly string[]) => {
      for (const st of stages) {
        if (st.at <= since) continue;
        if (st.stage === 'started') total += start;
        else if (settles.includes(st.stage)) total += settle;
      }
    };
    for (const r of this.deps.store.all()) {
      if (r.deposit) add(r.deposit.stages, ['completed', 'closed', 'abandoned']);
      for (const w of r.withdrawals) add(w.stages, ['completed', 'refunded']);
    }
    return total;
  }

  /** DUST the swaps in flight will still cost (their remaining starts and settles). */
  private committed(): bigint {
    const { dustPerStartSpecks: start, dustPerSettleSpecks: settle } = this.cfg;
    let total = 0n;
    for (const r of this.deps.store.all()) {
      const w = currentWithdrawal(r);
      switch (r.state) {
        case 'awaiting_funds':
          total += 2n * (start + settle);
          break;
        case 'depositing':
          total += (r.deposit?.requestId ? settle : start + settle) + start + settle;
          break;
        case 'minted':
        case 'taking':
        case 'taken':
          total += start + settle;
          break;
        case 'withdrawing':
        case 'bridging_back':
          total += w?.startTx || w?.startTxId || w?.startedAtMs ? settle : start + settle;
          break;
        default:
          break;
      }
    }
    return total;
  }

  /** Whether `newSwaps` more swaps would pass the daily DUST budget. */
  private overBudget(newSwaps: number): boolean {
    const budget = this.cfg.dailyDustBudgetSpecks;
    if (budget === 0n) return false;
    const perSwap = 2n * (this.cfg.dustPerStartSpecks + this.cfg.dustPerSettleSpecks);
    return this.spent24h() + this.committed() + BigInt(newSwaps) * perSwap > budget;
  }

  /** The budget as /health reports it. */
  budgetStatus(): BudgetStatus {
    const since = this.nowS() - 86_400;
    return {
      dustSpentSpecks24h: this.spent24h().toString(),
      dustBudgetSpecks24h: this.cfg.dailyDustBudgetSpecks.toString(),
      swapsOpened24h: this.deps.store.all().filter((r) => r.createdAt > since).length,
      unfundedOpen: this.unfundedCount(),
      unfundedMax: this.cfg.maxUnfundedSwaps,
      exhausted: this.overBudget(1),
    };
  }

  /** The page is looking at this swap: read its deposit address on the next pass. */
  nudge(rec: SwapRecord): void {
    if (rec.state === 'awaiting_funds') this.nextPoll.delete(rec.swapId);
  }

  /**
   * Drop failed swaps that never received anything once they are `retainUnfundedDays` old, after
   * one more read shows their deposit address empty (a late payment keeps the swap). At most
   * `limit` per call (the sweeper calls it every few minutes).
   */
  async pruneUnfunded(limit = 20): Promise<number> {
    const be = this.deps.backend();
    if (!be) return 0;
    const cutoff = this.nowS() - this.cfg.retainUnfundedDays * 86_400;
    const candidates = this.deps.store
      .all()
      .filter(
        (r) =>
          r.state === 'failed' &&
          r.reason === 'funds-not-received' &&
          r.deposit?.seenAt === undefined &&
          r.updatedAt <= cutoff,
      )
      .slice(0, limit);
    let dropped = 0;
    for (const r of candidates) {
      try {
        const [erc20, eth] = await Promise.all([
          be.evm.erc20Balance(r.pay.erc20Address, r.depositAddress),
          be.evm.ethBalance(r.depositAddress),
        ]);
        if (erc20 > 0n || eth > 0n) {
          r.deposit!.seenAt = this.nowS();
          this.persist(r);
          continue;
        }
      } catch {
        continue;
      }
      this.deps.store.delete(r.swapId);
      dropped++;
    }
    if (dropped > 0) this.deps.log.info('pruned never-funded swaps', { dropped });
    return dropped;
  }

  // ── Withdraw params ───────────────────────────────────────────────────────

  private withdrawLeg(rec: SwapRecord, kind: WithdrawKind): LegRecord {
    if (!WALLET_HOLDS_FUNDS.includes(rec.state)) {
      throw new SwapError(
        409,
        rec.state === 'withdrawing' || rec.state === 'bridging_back'
          ? SWAP_ERRORS.withdrawalInProgress
          : SWAP_ERRORS.wrongState,
        `a withdrawal is not possible while the swap is ${rec.state}`,
      );
    }
    // Either kind in minted / taking / taken: a startWithdraw spends the coin the temporary wallet
    // really holds, so a mistaken "taken" report cannot make the vault pay twice (audit C13).
    return kind === 'swap' ? rec.receive : rec.pay;
  }

  /** The EVM nonce the next withdrawal should sign. */
  private async nextWithdrawNonce(be: SwapBackend): Promise<bigint> {
    const pending = await be.evm.nonce(be.vaultEvmAddress, 'pending');
    let next = pending;
    const lane = this.laneNonce;
    if (lane && !lane.broadcast && lane.signedNonce + 1n > next) next = lane.signedNonce + 1n;
    return next + BigInt(this.withdrawalLane.waiting);
  }

  async withdrawParams(rec: SwapRecord, kind: WithdrawKind): Promise<WithdrawParams> {
    const leg = this.withdrawLeg(rec, kind);
    const be = this.deps.backend();
    if (!be) throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'the sponsor cannot bridge right now');
    let evmNonce: bigint;
    try {
      evmNonce = await this.nextWithdrawNonce(be);
    } catch {
      throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'Sepolia cannot be read right now; try again shortly');
    }
    // Remember what was handed out: /prove tells a vault that moved since (409) from a wrong call.
    const vaultMark = await be.vaultStateMark().catch(() => undefined);
    rec.withdrawOffer = { kind, evmNonce: evmNonce.toString(), ...(vaultMark ? { vaultMark } : {}), at: this.nowS() };
    this.persist(rec);
    const g = this.cfg.bridgeGas;
    return {
      kind,
      colour: leg.colour,
      amount: leg.amount,
      erc20Address: leg.erc20Address,
      dest: rec.evmAddress,
      refundRecipient: rec.tempCoinPk,
      gas: {
        gasLimit: g.gasLimit.toString(),
        maxFeePerGas: g.maxFeePerGas.toString(),
        maxPriorityFeePerGas: g.maxPriorityFeePerGas.toString(),
        keyVersion: g.keyVersion.toString(),
      },
      evmNonce: evmNonce.toString(),
      vaultAddress: be.vaultAddress,
    };
  }

  // ── Prove ─────────────────────────────────────────────────────────────────

  private inspect(bytes: Uint8Array, stage: 'unproven' | 'final'): TxSummary {
    try {
      return this.deps.inspect(bytes, stage);
    } catch (e) {
      if (e instanceof InvalidTxError) throw new SwapError(422, SWAP_ERRORS.invalidTx, e.message, e.detail);
      throw new SwapError(422, SWAP_ERRORS.invalidTx, 'the transaction could not be read', 'not-a-transaction');
    }
  }

  private judge(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      if (e instanceof InvalidTxError) throw new SwapError(422, SWAP_ERRORS.invalidTx, e.message, e.detail);
      throw e;
    }
  }

  private async proveOnServer(bytes: Uint8Array): Promise<Uint8Array> {
    const prover = this.deps.prover();
    if (!prover) throw new SwapError(503, SWAP_ERRORS.proverUnavailable, 'the proof server is not available');
    const release = await this.proverLane.acquire(`p${++this.seq}`);
    try {
      return await prover.prove(bytes);
    } catch (e) {
      this.deps.log.warn('proof failed', { error: e });
      throw new SwapError(503, SWAP_ERRORS.proverUnavailable, 'the proof server could not prove this transaction');
    } finally {
      release();
    }
  }

  private rebuildArgs(rec: SwapRecord, leg: LegRecord, coinNonce: string, evmNonce: bigint) {
    return {
      evmNonce,
      gas: this.cfg.bridgeGas,
      erc20: leg.erc20Address,
      amount: BigInt(leg.amount),
      dest: rec.evmAddress,
      colour: leg.colour,
      coinNonce,
      refundCoinPk: rec.tempCoinPk,
      tempCoinPk: rec.tempCoinPk,
      tempEncPk: rec.tempEncPk,
    };
  }

  /** Validate and prove; returns the proven (pre-binding) transaction's bytes. */
  async prove(rec: SwapRecord, req: ProveRequest & { kind?: WithdrawKind }): Promise<Uint8Array> {
    // The budget slot is taken before the first await and given back if nothing is proven, so
    // concurrent requests cannot pass the budget together (audit C11, F-B10).
    this.reserveProof(rec, req.purpose);
    let proven = false;
    try {
      if (!this.deps.prover())
        throw new SwapError(503, SWAP_ERRORS.proverUnavailable, 'the proof server is not available');
      const bytes = hexBytes(req.tx);
      const summary = this.inspect(bytes, 'unproven');
      const out =
        req.purpose === 'take'
          ? await this.proveTake(rec, bytes, summary)
          : await this.proveWithdraw(rec, bytes, summary, req);
      proven = true;
      return out;
    } finally {
      if (!proven) this.refundProof(rec, req.purpose);
    }
  }

  private reserveProof(rec: SwapRecord, purpose: 'take' | 'withdraw'): void {
    const total = rec.proofs.total ?? rec.proofs.take + rec.proofs.withdraw;
    if (rec.proofs[purpose] >= this.cfg.proofsPerSwap) {
      throw new SwapError(
        429,
        SWAP_ERRORS.proofBudget,
        purpose === 'withdraw'
          ? `this withdrawal attempt has used its ${this.cfg.proofsPerSwap} proofs`
          : `this swap has used its ${this.cfg.proofsPerSwap} take proofs`,
      );
    }
    if (total >= this.cfg.proofsTotalPerSwap) {
      throw new SwapError(429, SWAP_ERRORS.proofBudget, `this swap has used its ${this.cfg.proofsTotalPerSwap} proofs`);
    }
    rec.proofs[purpose]++;
    rec.proofs.total = total + 1;
  }

  private refundProof(rec: SwapRecord, purpose: 'take' | 'withdraw'): void {
    rec.proofs[purpose] = Math.max(0, rec.proofs[purpose] - 1);
    rec.proofs.total = Math.max(0, (rec.proofs.total ?? 1) - 1);
    this.persist(rec);
  }

  private async proveTake(rec: SwapRecord, bytes: Uint8Array, summary: TxSummary): Promise<Uint8Array> {
    if (rec.state !== 'minted' && rec.state !== 'taking') {
      throw new SwapError(409, SWAP_ERRORS.wrongState, `a take is not possible while the swap is ${rec.state}`);
    }
    this.judge(() =>
      validateTake(summary, {
        pay: { colour: rec.pay.colour, amount: BigInt(rec.pay.amount) },
        receive: { colour: rec.receive.colour, amount: BigInt(rec.receive.amount) },
      }),
    );
    const status = await this.deps.offers.status(rec.offerId).catch(() => 'unknown' as const);
    if (['consumed', 'expired', 'cancelled', 'not_found'].includes(status)) {
      throw new SwapError(409, SWAP_ERRORS.offerNotAvailable, `the offer is ${status}: Swap is not available`, status);
    }
    if (rec.state === 'minted') transition(rec, 'taking', this.nowS());
    rec.updatedAt = this.nowS();
    this.deps.store.put(rec);
    return this.proveOnServer(bytes);
  }

  private async proveWithdraw(
    rec: SwapRecord,
    bytes: Uint8Array,
    summary: TxSummary,
    req: Extract<ProveRequest, { purpose: 'withdraw' }> & { kind?: WithdrawKind },
  ): Promise<Uint8Array> {
    const be = this.deps.backend();
    if (!be) throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'the sponsor cannot bridge right now');
    const evmNonce = BigInt(req.evmNonce);
    let confirmed: bigint;
    try {
      confirmed = await be.evm.nonce(be.vaultEvmAddress, 'latest');
    } catch {
      throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'Sepolia cannot be read right now; try again shortly');
    }
    if (evmNonce < confirmed) {
      throw new SwapError(409, SWAP_ERRORS.staleEvmNonce, 'this EVM nonce is already used: rebuild the withdrawal');
    }
    // Nor one the lane can never reach: it would only cost a proof (audit F-A15).
    let next: bigint;
    try {
      next = await this.nextWithdrawNonce(be);
    } catch {
      throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'Sepolia cannot be read right now; try again shortly');
    }
    if (evmNonce > next + MAX_EVM_NONCE_AHEAD) {
      throw new SwapError(
        409,
        SWAP_ERRORS.staleEvmNonce,
        'this EVM nonce is ahead of the lane: rebuild the withdrawal',
      );
    }
    // The kind the page named, or both in the likelier order (the swap's own token after a take).
    const kinds: WithdrawKind[] = req.kind
      ? [req.kind]
      : rec.state === 'taken' || rec.takeTx
        ? ['swap', 'bridge-back']
        : ['bridge-back', 'swap'];
    let firstError: unknown = null;
    for (const kind of kinds) {
      const leg = this.withdrawLeg(rec, kind);
      let rebuilt;
      try {
        rebuilt = await be.rebuildWithdraw(this.rebuildArgs(rec, leg, req.coinNonce, evmNonce));
      } catch (e) {
        this.deps.log.warn('withdraw rebuild failed', { swapId: rec.swapId, error: e });
        throw new SwapError(
          503,
          SWAP_ERRORS.bridgeUnavailable,
          'the vault cannot be read right now; try again shortly',
        );
      }
      try {
        this.judge(() => validateWithdraw(summary, rebuilt, leg.colour));
      } catch (e) {
        firstError ??= e;
        continue;
      }
      rec.provenWithdraw = {
        kind,
        callsDigest: summary.callsDigest,
        coinNonce: req.coinNonce,
        evmNonce: evmNonce.toString(),
        at: this.nowS(),
      };
      if (kind === 'swap' && rec.state === 'taking') transition(rec, 'taken', this.nowS());
      rec.updatedAt = this.nowS();
      this.deps.store.put(rec);
      return this.proveOnServer(bytes);
    }
    // A transcript mismatch on a vault that moved since this swap's withdraw-params is a stale build,
    // not a wrong call: 409 with the rebuild hint (audit C11). Nothing is proven either way.
    if (firstError instanceof SwapError && firstError.detail === 'wrong-call' && rec.withdrawOffer?.vaultMark) {
      const mark = await be.vaultStateMark().catch(() => null);
      if (mark !== null && mark !== rec.withdrawOffer.vaultMark) {
        throw new SwapError(
          409,
          SWAP_ERRORS.staleVaultState,
          'the vault moved since this withdrawal was built: rebuild it and prove again',
          'vault-moved',
        );
      }
    }
    throw firstError ?? new SwapError(409, SWAP_ERRORS.wrongState, 'nothing can be withdrawn in this state');
  }

  // ── Take report ───────────────────────────────────────────────────────────

  reportTake(rec: SwapRecord, report: TakeReport): SwapRecord {
    const now = this.nowS();
    if (report.outcome === 'taken') {
      if (rec.state === 'taken' && rec.takeTx === report.takeTx) return rec;
      if (rec.state !== 'taking' && rec.state !== 'minted') {
        throw new SwapError(409, SWAP_ERRORS.wrongState, `the swap is ${rec.state}`);
      }
      rec.takeTx = report.takeTx;
      transition(rec, 'taken', now);
    } else {
      if (rec.state === 'minted') return rec;
      if (rec.state !== 'taking' && rec.state !== 'taken') {
        throw new SwapError(409, SWAP_ERRORS.wrongState, `the swap is ${rec.state}`);
      }
      // A "taken" report made in error (the take never landed) is undone by this one (audit C13).
      rec.takeTx = null;
      transition(rec, 'minted', now);
    }
    this.deps.store.put(rec);
    return rec;
  }

  // ── Withdraw ──────────────────────────────────────────────────────────────

  private sponsorReady(): void {
    const s = this.deps.sponsor();
    if (!s.synced)
      throw new SwapError(503, SWAP_ERRORS.sponsorUnavailable, 'the sponsor cannot pay network fees right now');
    if (s.dustSpecks !== null && s.dustSpecks < this.cfg.dustLowSpecks) {
      throw new SwapError(503, SWAP_ERRORS.sponsorLow, 'the sponsor is low on network fee funds; try again later');
    }
  }

  /** Accept the bound `startWithdraw` and run it in the background. */
  withdraw(rec: SwapRecord, txHex: string): SwapRecord {
    if (rec.state === 'withdrawing' || rec.state === 'bridging_back') {
      throw new SwapError(409, SWAP_ERRORS.withdrawalInProgress, 'a withdrawal of this swap is already running');
    }
    if (!WALLET_HOLDS_FUNDS.includes(rec.state)) {
      throw new SwapError(409, SWAP_ERRORS.wrongState, `a withdrawal is not possible while the swap is ${rec.state}`);
    }
    const proven = rec.provenWithdraw;
    if (!proven) throw new SwapError(409, SWAP_ERRORS.notProven, 'prove this withdrawal on the sponsor first');
    const bytes = hexBytes(txHex);
    const summary = this.inspect(bytes, 'final');
    if (summary.callsDigest !== proven.callsDigest) {
      throw new SwapError(409, SWAP_ERRORS.notProven, 'this is not the withdrawal the sponsor proved');
    }
    const leg = this.withdrawLeg(rec, proven.kind);
    this.judge(() => validateWithdraw(summary, { calls: summary.calls, callsDigest: proven.callsDigest }, leg.colour));
    if (!this.deps.backend())
      throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'the sponsor cannot bridge right now');
    this.sponsorReady();

    const now = this.nowS();
    const refunds = rec.withdrawals.filter((w) => w.stage === 'refunded').length;
    const w: WithdrawRecord = {
      kind: proven.kind,
      colour: leg.colour,
      amount: leg.amount,
      stage: 'queued',
      stages: [],
      refunds,
      evmNonce: proven.evmNonce,
      coinNonce: proven.coinNonce,
    };
    pushStage(w, 'queued', now, { evmNonce: proven.evmNonce });
    rec.withdrawals.push(w);
    rec.provenWithdraw = null;
    transition(rec, proven.kind === 'swap' ? 'withdrawing' : 'bridging_back', now);
    this.deps.store.put(rec);
    this.spawn(rec.swapId, () => this.driveWithdraw(rec.swapId, bytes));
    return rec;
  }

  private persist(rec: SwapRecord): void {
    rec.updatedAt = this.nowS();
    this.deps.store.put(rec);
  }

  private stage(
    rec: SwapRecord,
    target: DepositRecord | WithdrawRecord,
    stage: string,
    detail?: Record<string, string>,
  ) {
    pushStage(target, stage, this.nowS(), detail);
    this.persist(rec);
  }

  private get(swapId: string): SwapRecord {
    const rec = this.deps.store.get(swapId);
    if (!rec) throw new Error(`swap ${swapId} vanished from the store`);
    return rec;
  }

  /** The head-of-lane part: nonce and state re-checks, DUST, submit, the relayer until broadcast. */
  private async driveWithdraw(swapId: string, bytes: Uint8Array): Promise<void> {
    const be = this.deps.backend();
    const rec = this.get(swapId);
    const w = currentWithdrawal(rec)!;
    if (!be)
      return this.withdrawFailed(rec, w, new DriveError(SWAP_ERRORS.bridgeUnavailable, 'the bridge is not available'));
    const release = await this.withdrawalLane.acquire(swapId);
    let released = false;
    const releaseLane = () => {
      if (released) return;
      released = true;
      if (this.laneNonce?.swapId === swapId) this.laneNonce = null;
      release();
    };
    let started = false;
    try {
      this.stage(rec, w, 'starting');
      const leg = w.kind === 'swap' ? rec.receive : rec.pay;
      const evmNonce = BigInt(w.evmNonce);
      const [pending, vaultEthWei, vaultErc20] = await Promise.all([
        be.evm.nonce(be.vaultEvmAddress, 'pending'),
        be.evm.ethBalance(be.vaultEvmAddress),
        be.evm.erc20Balance(leg.erc20Address, be.vaultEvmAddress),
      ]);
      if (pending !== evmNonce) {
        throw new DriveError(
          SWAP_ERRORS.staleEvmNonce,
          `the vault account's nonce is now ${pending}, not ${evmNonce}: rebuild the withdrawal`,
        );
      }
      const pre = withdrawPreflight({ vaultEthWei, vaultErc20, amount: BigInt(leg.amount), gas: this.cfg.bridgeGas });
      if (!pre.ok) throw new DriveError(BRIDGE_ERRORS.preflight, pre.problems.join('; '));
      const rebuilt = await be.rebuildWithdraw(this.rebuildArgs(rec, leg, w.coinNonce, evmNonce));
      const summary = this.deps.inspect(bytes, 'final');
      if (rebuilt.callsDigest !== summary.callsDigest) {
        throw new DriveError(
          SWAP_ERRORS.staleVaultState,
          'the vault moved since this withdrawal was built: rebuild it',
        );
      }
      w.requestId = rebuilt.requestId;
      this.laneNonce = { swapId, signedNonce: evmNonce, broadcast: false };
      this.stage(rec, w, 'submitting', { requestId: rebuilt.requestId });
      let facts: MidnightTxFacts;
      try {
        facts = await this.withProver(() => be.submitWithdraw(bytes));
      } catch (e) {
        // It may have landed anyway: the request id tells.
        const open = await be.openRequests('withdraw').catch(() => null);
        if (!open?.ids.includes(rebuilt.requestId)) throw e;
        facts = { txId: '', txHash: null, status: 'SucceedEntirely' };
      }
      if (facts.status !== 'SucceedEntirely') {
        throw new DriveError('withdraw-start-failed', `the withdrawal did not succeed on chain (${facts.status})`);
      }
      started = true;
      w.startedAtMs = this.now();
      if (facts.txHash) w.startTx = facts.txHash;
      if (facts.txId) w.startTxId = facts.txId;
      this.stage(rec, w, 'started', { requestId: rebuilt.requestId, ...(facts.txHash ? { tx: facts.txHash } : {}) });
      await this.relayAndSettleWithdraw(swapId, be, false, releaseLane);
    } catch (e) {
      if (!started) this.withdrawFailed(rec, w, e);
      else this.withdrawStalled(rec, w, e);
    } finally {
      releaseLane();
    }
  }

  private async withProver<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.proverLane.acquire(`s${++this.seq}`);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** Before the start landed: nothing moved; back to `minted` with the reason, the app rebuilds. */
  private withdrawFailed(rec: SwapRecord, w: WithdrawRecord, e: unknown): void {
    const code = e instanceof DriveError || e instanceof SwapError ? e.code : 'internal-error';
    const message =
      e instanceof DriveError || e instanceof SwapError ? e.message : 'the sponsor could not start this withdrawal';
    if (!(e instanceof DriveError)) this.deps.log.warn('withdrawal start failed', { swapId: rec.swapId, error: e });
    w.error = { code, message };
    pushStage(w, 'failed', this.nowS(), { code });
    if (rec.state === 'withdrawing' || rec.state === 'bridging_back') transition(rec, 'minted', this.nowS());
    rec.proofs.withdraw = 0; // the next attempt gets a fresh budget (audit C11)
    this.persist(rec);
  }

  /** After the start landed: the request is open in the vault; the stale closer drives it again. */
  private withdrawStalled(rec: SwapRecord, w: WithdrawRecord, e: unknown): void {
    this.deps.log.warn('withdrawal relay stalled', { swapId: rec.swapId, requestId: w.requestId, error: e });
    if (isSignatureTimeout(e)) this.mpc.timeouts.push(this.now());
    w.error = {
      code: isSignatureTimeout(e) ? BRIDGE_ERRORS.mpcTimeout : BRIDGE_ERRORS.attestationTimeout,
      message: 'the withdrawal is waiting on Sepolia and the MPC; the sponsor will resume it',
    };
    pushStage(w, 'relay-stalled', this.nowS());
    this.persist(rec);
  }

  /** Resume a withdrawal after a restart (or for the stale closer). */
  async resumeWithdraw(swapId: string): Promise<void> {
    const rec = this.get(swapId);
    const w = currentWithdrawal(rec);
    const be = this.deps.backend();
    if (!w || !be || (rec.state !== 'withdrawing' && rec.state !== 'bridging_back')) return;
    if (!w.requestId)
      return this.withdrawFailed(
        rec,
        w,
        new DriveError('interrupted', 'the sponsor restarted before this withdrawal started: rebuild it'),
      );
    if (!w.startTx && !w.startTxId) {
      const open = await be.openRequests('withdraw');
      if (!open.ids.includes(w.requestId)) {
        return this.withdrawFailed(
          rec,
          w,
          new DriveError('interrupted', 'the sponsor restarted before this withdrawal started: rebuild it'),
        );
      }
    }
    // Until its transfer is broadcast, a resumed withdrawal still owns its nonce: hold the lane.
    const release = await this.withdrawalLane.acquire(swapId);
    let released = false;
    const releaseLane = () => {
      if (released) return;
      released = true;
      if (this.laneNonce?.swapId === swapId) this.laneNonce = null;
      release();
    };
    this.laneNonce = { swapId, signedNonce: BigInt(w.evmNonce), broadcast: false };
    try {
      this.stage(rec, w, 'resumed');
      await this.relayAndSettleWithdraw(swapId, be, true, releaseLane);
    } catch (e) {
      this.withdrawStalled(rec, w, e);
    } finally {
      releaseLane();
    }
  }

  private onRelayProgress(
    rec: SwapRecord,
    target: DepositRecord | WithdrawRecord,
    p: RelayProgress,
    releaseLane?: () => void,
  ): void {
    const s = (ms: number) => String(Math.round(ms / 1000));
    switch (p.stage) {
      case 'signed':
        this.mpc.lastSignatureAfterMs = p.afterMs;
        this.stage(rec, target, 'mpc-signed', {
          signedTx: p.signedTxHash,
          evmNonce: String(p.nonce),
          afterS: s(p.afterMs),
        });
        return;
      case 'broadcast':
        if ('kind' in target) target.sepoliaTx = p.evmTxHash;
        else target.sweepTx = p.evmTxHash;
        if (this.laneNonce?.swapId === rec.swapId) this.laneNonce.broadcast = true;
        this.stage(rec, target, 'evm-broadcast', {
          evmTx: p.evmTxHash,
          evmBlock: String(p.evmBlock),
          evmStatus: String(p.evmStatus ?? ''),
        });
        releaseLane?.();
        return;
      case 'not-broadcast':
        this.stage(rec, target, 'evm-not-broadcast', { reason: p.reason.slice(0, 200) });
        releaseLane?.();
        return;
      case 'finalized':
        this.stage(rec, target, 'evm-final', {
          evmBlock: String(p.evmBlock),
          finalizedBlock: String(p.finalizedBlock),
        });
        return;
      case 'attested':
        return; // recorded with the outcome
    }
  }

  private async relayAndSettleWithdraw(
    swapId: string,
    be: SwapBackend,
    resumed: boolean,
    releaseLane: () => void,
  ): Promise<void> {
    const rec = this.get(swapId);
    const w = currentWithdrawal(rec)!;
    const requestId = w.requestId!;
    const budget = resumed
      ? MPC_SIGNATURE_BUDGET_MS
      : Math.max(60_000, MPC_SIGNATURE_BUDGET_MS - Math.max(0, this.now() - (w.startedAtMs ?? this.now())));
    const relay: RelayOutcome = await be.relay({
      kind: 'withdraw',
      requestId,
      expectedSigner: be.vaultEvmAddress,
      signatureTimeoutMs: budget,
      onProgress: (p) => this.onRelayProgress(rec, w, p, releaseLane),
    });
    releaseLane();
    if (relay.evmTxHash) w.sepoliaTx = relay.evmTxHash;
    w.attested = relay.kind;
    this.stage(rec, w, 'attested', { kind: relay.kind, ...(relay.evmTxHash ? { evmTx: relay.evmTxHash } : {}) });
    const circuit = relay.kind === 'never-executed' ? 'refundWithdraw' : 'completeWithdraw';
    this.stage(rec, w, 'completing', { circuit });
    const settled = await this.withProver(() =>
      be.settle({
        circuit,
        requestId,
        attestation: relay,
        recipientCoinPk: rec.tempCoinPk,
        recipientEncPk: rec.tempEncPk,
      }),
    );
    if (settled.txHash) w.completeTx = settled.txHash;
    if (settled.txId) w.completeTxId = settled.txId;
    delete w.error;
    const now = this.nowS();
    if (settled.minted) {
      // The transfer did not happen: the coin is back in the temporary wallet (plan Q9 A).
      pushStage(w, 'refunded', now, { circuit, ...(settled.txHash ? { tx: settled.txHash } : {}) });
      transition(rec, 'minted', now);
      rec.proofs.withdraw = 0; // the retry gets a fresh budget (audit C11)
      this.deps.log.info('withdrawal refunded', { swapId, requestId, attested: relay.kind });
    } else {
      pushStage(w, 'completed', now, { circuit, ...(settled.txHash ? { tx: settled.txHash } : {}) });
      rec.outcome = w.kind === 'swap' ? 'swapped' : 'bridged-back';
      transition(rec, 'done', now);
      this.deps.log.info('swap done', { swapId, outcome: rec.outcome });
    }
    this.persist(rec);
  }

  // ── Deposit ───────────────────────────────────────────────────────────────

  /** One pass over the `awaiting_funds` swaps (the timer calls it; tests call it directly). */
  pollDeposits(): Promise<void> {
    this.polling ??= this.pollOnce()
      .catch((e: unknown) => this.deps.log.warn('deposit poll failed', { error: e }))
      .finally(() => {
        this.polling = null;
      });
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    const be = this.deps.backend();
    const now = this.nowS();
    const nowMs = this.now();
    const b = this.cfg.pollBackoffMs;
    for (const rec of this.deps.store.all()) {
      if (rec.state !== 'awaiting_funds' || this.driving.has(rec.swapId)) {
        this.nextPoll.delete(rec.swapId);
        continue;
      }
      // Without a bridge the address cannot be read: never fail a swap on its age unread.
      if (!be) continue;
      if ((this.nextPoll.get(rec.swapId) ?? 0) > nowMs) continue;
      const d = rec.deposit!;
      const amount = BigInt(rec.pay.amount);
      // The token first; the sweep ETH only once the token is there (one read per pass, audit C6).
      let erc20: bigint;
      let eth = 0n;
      try {
        erc20 = await be.evm.erc20Balance(rec.pay.erc20Address, rec.depositAddress);
        if (erc20 >= amount) eth = await be.evm.ethBalance(rec.depositAddress);
      } catch (e) {
        this.deps.log.warn('deposit address read failed', { swapId: rec.swapId, error: e });
        continue;
      }
      if (erc20 > 0n && d.seenAt === undefined) {
        d.seenAt = now;
        this.persist(rec);
      }
      const tokenThere = erc20 >= amount;
      // The balance first, the age second: a swap whose token reached the address is never failed for
      // its age, whatever kept the sponsor from starting it (audit C5). A swap that received nothing
      // gets the short window, one with part of the token the long one (audit C6).
      const since = [...rec.history].reverse().find((h) => h.state === 'awaiting_funds')?.at ?? rec.createdAt;
      const window = d.seenAt === undefined ? this.cfg.fundsWaitSeconds : this.cfg.fundsWaitPartialSeconds;
      if (!tokenThere && now - since > window) {
        transition(rec, 'failed', now, {
          reason: 'funds-not-received',
          message: 'the deposit address did not receive the funds in time; re-open the swap to keep waiting',
          recoverable: true,
        });
        this.nextPoll.delete(rec.swapId);
        this.persist(rec);
        continue;
      }
      const age = now - since;
      this.nextPoll.set(
        rec.swapId,
        nowMs + (d.seenAt !== undefined || age < 600 ? b.fast : age < 3_600 ? b.medium : b.slow),
      );
      if (!tokenThere || eth < BigInt(rec.sweepGas.ethWei)) continue;
      const s = this.deps.sponsor();
      if (!s.synced || (s.dustSpecks !== null && s.dustSpecks < this.cfg.dustLowSpecks)) continue;
      this.stage(rec, rec.deposit!, 'funds-seen', { erc20: erc20.toString(), wei: eth.toString() });
      transition(rec, 'depositing', this.nowS());
      this.persist(rec);
      this.spawn(rec.swapId, () => this.driveDeposit(rec.swapId));
    }
  }

  /** Start (or resume) a swap's deposit and drive it to `minted`. */
  async driveDeposit(swapId: string): Promise<void> {
    const rec = this.get(swapId);
    const d = rec.deposit!;
    const be = this.deps.backend();
    if (!be || rec.state !== 'depositing') return;
    const gas: EvmGasPolicy = {
      gasLimit: BigInt(rec.sweepGas.gasLimit),
      maxFeePerGas: BigInt(rec.sweepGas.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(rec.sweepGas.maxPriorityFeePerGas),
      keyVersion: 1n,
    };
    let resumed = d.requestId !== undefined;
    if (!d.requestId) {
      try {
        // An earlier start of this swap may be open already (a crash after it landed): adopt it.
        const path = be.depositPathHex(rec.tempCoinPk);
        const open = await be.openRequests('deposit');
        const mine = open.ids.filter((id) => open.pathOf(id) === path);
        if (mine.length > 0) {
          d.requestId = mine[0]!;
          resumed = true;
          this.stage(rec, d, 'adopted', { requestId: d.requestId });
        } else {
          if (d.attempts >= this.cfg.maxDepositAttempts) {
            transition(rec, 'failed', this.nowS(), {
              reason: 'deposit-attempts',
              message: `the deposit was tried ${d.attempts} times without success; the funds wait at the deposit address`,
              recoverable: (d.rearms ?? 0) < this.cfg.maxDepositRearms,
            });
            this.persist(rec);
            return;
          }
          const [erc20, eth, evmNonce] = await Promise.all([
            be.evm.erc20Balance(rec.pay.erc20Address, rec.depositAddress),
            be.evm.ethBalance(rec.depositAddress),
            be.evm.nonce(rec.depositAddress, 'pending'),
          ]);
          const pre = depositPreflight({
            erc20Balance: erc20,
            amount: BigInt(rec.pay.amount),
            ethBalance: eth,
            gasLimit: gas.gasLimit,
            maxFeePerGas: gas.maxFeePerGas,
            decimals: rec.pay.decimals,
          });
          if (!pre.ok) throw new DriveError(BRIDGE_ERRORS.preflight, pre.problems.join('; '));
          d.attempts++;
          this.stage(rec, d, 'starting', { evmNonce: evmNonce.toString() });
          const out = await this.withProver(() =>
            be.startDeposit({
              recipientCoinPk: rec.tempCoinPk,
              erc20: rec.pay.erc20Address,
              amount: BigInt(rec.pay.amount),
              gas,
              evmNonce,
            }),
          );
          d.requestId = out.requestId;
          d.startedAtMs = this.now();
          if (out.txHash) d.startTx = out.txHash;
          if (out.txId) d.startTxId = out.txId;
          this.stage(rec, d, 'started', { requestId: out.requestId, ...(out.txHash ? { tx: out.txHash } : {}) });
        }
      } catch (e) {
        const code = e instanceof DriveError ? e.code : 'deposit-start-failed';
        this.deps.log.warn('deposit start failed', { swapId, error: e });
        pushStage(d, 'waiting-for-funds', this.nowS(), { error: code });
        transition(rec, 'awaiting_funds', this.nowS());
        this.persist(rec);
        return;
      }
    }
    await this.relayAndSettleDeposit(rec, be, resumed);
  }

  private async relayAndSettleDeposit(rec: SwapRecord, be: SwapBackend, resumed: boolean): Promise<void> {
    const d = rec.deposit!;
    const requestId = d.requestId!;
    let relay: RelayOutcome;
    try {
      const budget = resumed
        ? MPC_SIGNATURE_BUDGET_MS
        : Math.max(60_000, MPC_SIGNATURE_BUDGET_MS - Math.max(0, this.now() - (d.startedAtMs ?? this.now())));
      relay = await be.relay({
        kind: 'deposit',
        requestId,
        expectedSigner: rec.depositAddress,
        signatureTimeoutMs: budget,
        onProgress: (p) => this.onRelayProgress(rec, d, p),
      });
    } catch (e) {
      if (isSignatureTimeout(e)) this.mpc.timeouts.push(this.now());
      this.deps.log.warn('deposit relay stalled', { swapId: rec.swapId, requestId, error: e });
      this.stage(rec, d, 'relay-stalled');
      return;
    }
    if (relay.evmTxHash) d.sweepTx = relay.evmTxHash;
    d.attested = relay.kind;
    this.stage(rec, d, 'attested', { kind: relay.kind, ...(relay.evmTxHash ? { evmTx: relay.evmTxHash } : {}) });
    await this.settleDeposit(rec, be, relay);
  }

  private async settleDeposit(rec: SwapRecord, be: SwapBackend, att: Attestation): Promise<void> {
    const d = rec.deposit!;
    const requestId = d.requestId!;
    if (att.kind === 'never-executed') {
      // The sweep never ran (the tokens are still at the deposit address): close the request with
      // the vault's abandonDeposit, and let the poll start again while the funds are there.
      this.stage(rec, d, 'abandoning');
      const out = await this.withProver(() => be.abandonDeposit({ requestId, attestation: att }));
      pushStage(d, 'abandoned', this.nowS(), { requestId, ...(out.txHash ? { tx: out.txHash } : {}) });
      delete d.requestId;
      delete d.startedAtMs;
      transition(rec, 'awaiting_funds', this.nowS());
      pushStage(d, 'waiting-for-funds', this.nowS(), { retry: String(d.attempts + 1) });
      this.persist(rec);
      return;
    }
    this.stage(rec, d, 'completing');
    const out = await this.withProver(() =>
      be.settle({
        circuit: 'completeDeposit',
        requestId,
        attestation: att,
        recipientCoinPk: rec.tempCoinPk,
        recipientEncPk: rec.tempEncPk,
      }),
    );
    if (out.txHash) d.completeTx = out.txHash;
    if (out.txId) d.completeTxId = out.txId;
    const now = this.nowS();
    if (out.minted) {
      pushStage(d, 'completed', now, { ...(out.txHash ? { tx: out.txHash } : {}) });
      transition(rec, 'minted', now);
      this.deps.log.info('deposit minted', { swapId: rec.swapId, requestId });
    } else {
      pushStage(d, 'closed', now, { attested: att.kind });
      transition(rec, 'failed', now, {
        reason: 'deposit-returned-false',
        message: 'the token refused the vault’s transfer: nothing was minted (the funds stay at the deposit address)',
        recoverable: (d.rearms ?? 0) < this.cfg.maxDepositRearms,
      });
    }
    this.persist(rec);
  }

  // ── The stale closer's hooks ──────────────────────────────────────────────

  /** Swaps with a request in flight that nothing drives and that last moved before `olderThanS`. */
  stalled(olderThanS: number): SwapRecord[] {
    return this.deps.store
      .all()
      .filter(
        (r) =>
          (r.state === 'depositing' || r.state === 'withdrawing' || r.state === 'bridging_back') &&
          !this.driving.has(r.swapId) &&
          r.updatedAt <= olderThanS,
      );
  }

  /** Drive a stalled swap again (resumable). Returns false when it is already being driven. */
  redrive(rec: SwapRecord): boolean {
    if (rec.state === 'depositing') return this.spawn(rec.swapId, () => this.driveDeposit(rec.swapId));
    if (rec.state === 'withdrawing' || rec.state === 'bridging_back') {
      return this.spawn(rec.swapId, () => this.resumeWithdraw(rec.swapId));
    }
    return false;
  }

  /**
   * A withdrawal that failed before its start was confirmed, whose predicted request is open in
   * the vault after all (the start landed late): adopt it and drive it. Returns the adopted swaps.
   */
  async adoptLateStarts(sinceS: number): Promise<string[]> {
    const be = this.deps.backend();
    if (!be) return [];
    const candidates = this.deps.store.all().filter((r) => {
      const w = currentWithdrawal(r);
      return (
        (r.state === 'minted' || r.state === 'taking' || r.state === 'taken') &&
        w?.stage === 'failed' &&
        w.requestId !== undefined &&
        !this.driving.has(r.swapId) &&
        (w.stages.at(-1)?.at ?? 0) >= sinceS
      );
    });
    if (candidates.length === 0) return [];
    const open = await be.openRequests('withdraw');
    const adopted: string[] = [];
    for (const rec of candidates) {
      const w = currentWithdrawal(rec)!;
      if (!open.ids.includes(w.requestId!)) continue;
      delete w.error;
      pushStage(w, 'adopted', this.nowS(), { requestId: w.requestId! });
      const to: SwapState = w.kind === 'swap' ? 'withdrawing' : 'bridging_back';
      transition(rec, to, this.nowS());
      this.persist(rec);
      this.spawn(rec.swapId, () => this.resumeWithdraw(rec.swapId));
      adopted.push(rec.swapId);
    }
    return adopted;
  }
}

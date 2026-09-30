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
// DEPOSIT (server-driven). A poll watches every `awaiting_funds` swap's deposit address (the token
// first, with backoff for addresses that received nothing; audit C6); once it holds at least the pay
// amount of the ERC20 and the sweep ETH, the sponsor (its own wallet paying) submits `startDeposit`
// (recipient = the temporary coin public key), runs the relayer (the MPC signs the sweep, it is
// broadcast, Sepolia finality, the attestation) and submits `completeDeposit` with the temporary
// encryption key mapped, so the coin is sealed to the temporary wallet. The sweep's fee is fixed at
// `startDeposit` from the live base fee and the ETH at the address (the largest cap it covers); too
// little ETH for the live fee raises the swap's sweep gas and waits for the page to top up (audit
// C2). A sweep attested never-executed is abandoned (`abandonDeposit`) and retried while the funds
// are still there (at most `maxDepositAttempts` starts); a deposit that failed with its funds at the
// address is recoverable: a re-open re-arms it with a new `startDeposit` to the same recipient
// (audit C5). Only a request that moves this swap's token and amount is ever adopted (audit C12).
//
// PROVE. The sponsor proves with its own proof server and key directory, but only a take of THIS
// swap's offer, or THIS swap's `startWithdraw` (../validate/rules.ts), within a per-swap budget.
//
// WITHDRAW. The browser's proven, bound `startWithdraw` (the same calls its latest `/prove withdraw`
// validated) waits for the ONE withdrawal lane: every withdrawal is paid from the vault's single EVM
// account, so its nonce orders them. At the head of the lane the sponsor re-checks the nonce, the
// gas against the live base fee and the calls against the vault's live state, adds DUST and
// submits. The lane is released as soon as the start is on chain: from then on the withdrawal's
// persisted record holds its nonce (a RESERVATION) until it settles or the nonce is consumed, and
// the next withdrawal signs the account's pending nonce past every reservation, so no two starts
// share a nonce, across timeouts and restarts (audit C3). The relayer loop (../bridge/relay-loop.ts)
// then runs outside the lane, with deadlines only: it re-broadcasts the signed transfer until it is
// mined or its nonce is consumed. A transfer the MPC signed that stays unmined past
// `stuckTransferMs` with the base fee above its cap, or a start still unsigned past
// `unsignedStaleMs`, is STUCK: the MPC never attests it, so the next withdrawal takes its nonce (a
// replacement: one of the two is mined, the other is attested never executed and refunded; audit
// C2). Each withdrawal's fee is sized from the live base fee when withdraw-params hands it out:
// max(the policy's floor, 2 × base fee + tip), within BRIDGE_EVM_MAX_FEE_CAP_WEI. Then the
// attestation and `completeWithdraw` (or `refundWithdraw`). A refund (the transfer did not happen,
// e.g. a nonce taken by another service, plan Q9 A) returns the swap to `minted`, and the view's
// `withdrawal.retry` tells the app to rebuild and retry (audit C1). The same path serves Bridge back
// (the paid token), in minted, taking or taken (audit C13).
//
// RESTARTS. Every step is persisted before and after it runs (./store.ts). At start-up the service
// resumes every swap in flight from its recorded request id (the relayer loop is resumable).
//
// THE ROUND-2 FIXES (plan 00048 P4.2-fix2, audit "Consolidation, round 2" R1–R6):
//   R1 every output of a take or a withdrawal is the vault's coin or a coin the page disclosed as the
//      temporary wallet's (`walletOutputs`, recomputed with its coin public key), and `/withdraw`
//      must erase to exactly the transaction `/prove` validated (the whole serialisation is kept);
//   R2 a replacement of a stuck transfer outbids EVERY competing transfer of its nonce on both fee
//      fields by the pool's replacement increment (10%, rounded up);
//   R3 throttles replenish (rolling 24-hour proof budgets, re-arms paced by a cooldown and a per-day
//      count) and never make a funded swap unrecoverable; a transient `/withdraw` refusal gives its
//      proof back; failed prover work counts in the daily budget;
//   R4 DUST is committed when funds arrive, not at open; an open (and the revival of a swap that
//      received nothing) needs the owner to hold the funds on Sepolia and passes per-client caps;
//      page reads cannot reset the deposit poll's backoff, and each pass reads a bounded number of
//      addresses;
//   R5 a submission whose outcome is unknown keeps its nonce (`submission-uncertain`) until the
//      request id shows it landed or it provably did not; retries wait for every attempt to settle;
//   R6 a deposit request is adopted only when it carries the sponsor's own parameters, and any
//      request that swept this recipient's deposit address is completed, whoever started it.
//
// THE ROUND-3 FIXES (plan 00048 P4.2-fix3, audit "Consolidation, round 3" S1–S8):
//   S1 "not included" is concluded only from a vault read AS OF an indexer block past the
//      submission's expiry (its DUST intent's time to live) plus a margin, never from a failed
//      attestation lookup; an attempt so judged is re-checked for a day and adopted if it landed;
//   S2 the vault's deposit requests are reconciled for every waiting recipient whatever its address
//      shows; what completed requests minted is counted, and less than the pay amount is `partial`:
//      the sponsor deposits the remainder by itself once it is at the address, or the page bridges
//      back what arrived;
//   S3 adoption checks BOTH fee fields of a request against the live sweep policy, and the sponsor's
//      own request outbids every other request of the same deposit-address nonce;
//   S4 retention never drops a record with anything left to recover (./model.ts retentionMayDrop);
//   S5 IPv6 clients count by /48; a swap is unfunded until its WHOLE pay amount arrived; the global
//      unfunded cap is a backstop (1,000);
//   S6 a foreign completion reserves its settle from the daily budget before it is queued;
//   S7 (accepted) shielded inputs are not bound to the temporary wallet (../validate/rules.ts);
//   S8 `/withdraw` honours only approvals of the current version (PROVEN_WITHDRAW_VERSION).

import {
  BRIDGE_ERRORS,
  SWAP_ERRORS,
  depositPreflight,
  withdrawPreflight,
  type EvmGasPolicy,
  type OpenSwapPayload,
  type ProveRequest,
  type TakeReport,
  type TokenEntry,
  type TokenRegistry,
  type WalletOutput,
  type WithdrawKind,
  type WithdrawParams,
} from '@evm-midnight-transparent/core';
import { getAddress } from 'ethers';

import { issueSwapToken, tokenMatches } from '../auth/swap-token.js';
import type { SponsorConfig } from '../config.js';
import type { Logger } from '../log.js';
import { FifoLock } from '../queue/fifo-lock.js';
import type { SponsorStatus } from '../sponsor/session.js';
import { InvalidTxError, validateTake, validateWithdraw, type WalletCommitments } from '../validate/rules.js';
import type { TxSummary } from '../validate/summary.js';
import {
  NotSubmittedError,
  WITHDRAW_TX_TTL_MS,
  type Attestation,
  type MidnightTxFacts,
  type OfferReader,
  type OpenRequests,
  type RelayOutcome,
  type RelayProgress,
  type SwapBackend,
  type SwapProver,
} from './backend.js';
import { DriveError, SwapError } from './errors.js';
import {
  PROVEN_WITHDRAW_VERSION,
  RECOVERABLE_FAILURES,
  WALLET_HOLDS_FUNDS,
  currentWithdrawal,
  heldOf,
  holdingState,
  isRecheck,
  isTerminal,
  isUnresolved,
  mintedTotalOf,
  pushStage,
  remainingOf,
  transition,
  type DepositRecord,
  type GasRecord,
  type LegRecord,
  type ProofEntry,
  type SwapRecord,
  type WithdrawRecord,
} from './model.js';
import type { SwapStore } from './store.js';
import { sizeSweepGas } from './sweep-gas.js';

/** The MPC signature budget, counted from the start (upstream `POLL_TIMEOUT_MS`). */
export const MPC_SIGNATURE_BUDGET_MS = 20 * 60_000;
/** How far past the lane's next nonce a `/prove withdraw` may name (audit F-A15). */
export const MAX_EVM_NONCE_AHEAD = 2n;
/** A re-checked attempt's attestation is read at most this often (audit S1). */
export const RECHECK_ATTESTATION_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

export interface SwapServiceConfig {
  network: string;
  tokens: TokenRegistry;
  /** The gas fields a withdrawal signs (the vault's EVM account pays them); `maxFeePerGas` is the
   *  floor of the live sizing (audit C2). */
  bridgeGas: EvmGasPolicy;
  /** The most a withdrawal's `maxFeePerGas` may be. */
  bridgeMaxFeeCapWei: bigint;
  /** A signed transfer unmined this long with the base fee above its cap is replaced (ms). */
  stuckTransferMs: number;
  /** A started withdrawal unsigned this long is replaced (ms). */
  unsignedStaleMs: number;
  sweepGasLimits: Readonly<Record<string, bigint>>;
  /** Refuse to open a swap whose sweep would need more ETH than this (a gas spike). */
  maxSweepWei: bigint;
  minOfferTtlSeconds: number;
  maxActiveSwapsPerOwner: number;
  /** New swaps per EVM address in any 24 hours (audit C7). */
  maxSwapsPerOwnerPerDay: number;
  /** Swaps waiting for funds that have received nothing, all addresses together (audit C6). */
  maxUnfundedSwaps: number;
  /** Proofs per swap and purpose in any 24 hours; the withdraw budget also renews for each new
   *  attempt (audit C11, R3). */
  proofsPerSwap: number;
  /** Every proof of one swap together in any 24 hours, failed prover work included (audit R3: a
   *  replenishing budget, not a lifetime cap). */
  proofsPerSwapPerDay: number;
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
  /** A re-open re-arms a deposit that failed with its funds at the address at most this often in any
   *  24 hours, and not sooner than `depositRearmCooldownSeconds` after the previous re-arm (audit R3:
   *  paced, never a lifetime cap: a funded swap stays recoverable). */
  depositRearmsPerDay: number;
  depositRearmCooldownSeconds: number;
  /** Swaps waiting for funds (not yet the whole pay amount at the address), per client (IPv4 address or IPv6 /48). */
  maxUnfundedPerClient: number;
  /** How long an open reuses its read of the owner's Sepolia balances (ms; audit R4). */
  ownerBalanceCacheMs: number;
  /** Deposit-address reads in one poll pass, all swaps together (audit R4). */
  pollMaxReadsPerPass: number;
  /** A page looking at a swap brings its next read forward, never closer than this to the last (ms). */
  pollNudgeMinMs: number;
  /** An uncertain withdrawal submission whose request is neither in the vault nor attested this long
   *  after it was sent did not land (ms; audit R5), provided the vault read is fresh (below). */
  uncertainWindowMs: number;
  /** "Not included" needs a vault read at an indexer block at least this far past the submission's
   *  expiry (ms; audit S1). */
  expiryMarginMs: number;
  /** An attempt judged not included is re-checked by its request id this long (ms; audit S1). */
  recheckMs: number;
  /** How often the vault's open deposit requests are read for the swaps waiting for funds or
   *  `partial`, whatever their deposit addresses show (ms; audit S2). */
  reconcileMs: number;
  /** A replacement outbids every competing transfer of its nonce on both fee fields by at least
   *  this percent, rounded up (the pools' replacement increment; audit R2). */
  replacementBumpPercent: bigint;
  /** Below this, the sponsor spends nothing new (specks). */
  dustLowSpecks: bigint;
}

/** The service's configuration from the sponsor's (main.ts and the tests share it). */
export function swapServiceConfig(c: SponsorConfig): SwapServiceConfig {
  return {
    network: c.network.name,
    tokens: c.tokens,
    bridgeGas: c.bridgeGas,
    bridgeMaxFeeCapWei: c.bridgeMaxFeeCapWei,
    stuckTransferMs: c.withdrawStuckAfterSeconds * 1000,
    unsignedStaleMs: c.withdrawUnsignedStaleSeconds * 1000,
    sweepGasLimits: c.swaps.sweepGasLimits,
    maxSweepWei: c.swaps.maxSweepWei,
    minOfferTtlSeconds: c.swaps.minOfferTtlSeconds,
    maxActiveSwapsPerOwner: c.swaps.maxActivePerOwner,
    maxSwapsPerOwnerPerDay: c.swaps.maxPerOwnerPerDay,
    maxUnfundedSwaps: c.swaps.maxUnfunded,
    proofsPerSwap: c.swaps.proofsPerSwap,
    proofsPerSwapPerDay: c.swaps.proofsPerSwapPerDay,
    depositPollMs: c.swaps.depositPollSeconds * 1000,
    pollBackoffMs: { fast: c.swaps.depositPollSeconds * 1000, medium: 60_000, slow: 300_000 },
    fundsWaitSeconds: c.swaps.fundsWaitSeconds,
    fundsWaitPartialSeconds: c.swaps.fundsWaitPartialSeconds,
    retainUnfundedDays: c.swaps.retainUnfundedDays,
    dailyDustBudgetSpecks: c.swaps.dailyDustBudgetSpecks,
    dustPerStartSpecks: c.swaps.dustPerStartSpecks,
    dustPerSettleSpecks: c.swaps.dustPerSettleSpecks,
    maxDepositAttempts: c.swaps.maxDepositAttempts,
    depositRearmsPerDay: c.swaps.depositRearmsPerDay,
    depositRearmCooldownSeconds: c.swaps.depositRearmCooldownSeconds,
    maxUnfundedPerClient: c.swaps.maxUnfundedPerClient,
    ownerBalanceCacheMs: c.swaps.ownerBalanceCacheSeconds * 1000,
    pollMaxReadsPerPass: c.swaps.pollMaxReadsPerPass,
    pollNudgeMinMs: c.swaps.pollNudgeMinSeconds * 1000,
    uncertainWindowMs: c.withdrawUncertainSeconds * 1000,
    expiryMarginMs: c.withdrawExpiryMarginSeconds * 1000,
    recheckMs: c.withdrawRecheckSeconds * 1000,
    reconcileMs: c.swaps.reconcileSeconds * 1000,
    replacementBumpPercent: BigInt(c.bridgeReplacementBumpPercent),
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
  /** sha256 (hex) of a maker's `swapoffer1…` transaction bytes: the kernel's offer id (audit C4). */
  makerTxId: (offerBech32: string) => string;
  /** The commitment of a coin owned by `coinPk` (ledger-v9 `coinCommitment`; a fake in tests): the
   *  sponsor recomputes each disclosed wallet output with the temporary coin public key (audit R1). */
  coinCommitment: (coin: { nonce: string; colour: string; value: bigint }, coinPk: string) => string;
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

const TENTH_GWEI = 100_000_000n;
const ceilTenthGwei = (x: bigint) => ((x + TENTH_GWEI - 1n) / TENTH_GWEI) * TENTH_GWEI;
const floorTenthGwei = (x: bigint) => (x / TENTH_GWEI) * TENTH_GWEI;

const gasRecord = (g: EvmGasPolicy): GasRecord => ({
  gasLimit: g.gasLimit.toString(),
  maxFeePerGas: g.maxFeePerGas.toString(),
  maxPriorityFeePerGas: g.maxPriorityFeePerGas.toString(),
});

const gasOf = (g: GasRecord | undefined, dflt: EvmGasPolicy): EvmGasPolicy =>
  g
    ? {
        gasLimit: BigInt(g.gasLimit),
        maxFeePerGas: BigInt(g.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(g.maxPriorityFeePerGas),
        keyVersion: dflt.keyVersion,
      }
    : dflt;

/** A withdrawal of this sponsor whose start landed and that has not settled: it owns its EVM nonce
 *  until it settles or the nonce is consumed (audit C3). */
export interface Reservation {
  swapId: string;
  nonce: bigint;
  signed: boolean;
  mined: boolean;
  startedAtMs: number;
  signedAtMs?: number;
  /** The highest fee fields this request's transfer may carry (the request's and the signed one's). */
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** A submission whose outcome is unknown (audit R5): never judged stuck, never replaced. */
  uncertain: boolean;
}

/** A proof's budget entry, and whether its work reached the proof server (audit R3). */
interface ProofTicket {
  entry: ProofEntry;
  dispatched: boolean;
}

/** The nonce the head of the lane signs, and the transfers already holding it (a replacement). */
export interface LaneNonce {
  nonce: bigint;
  competing: Reservation[];
}

export class SwapService {
  private readonly now: () => number;
  /** Background drives by swap id: one at a time per swap. */
  private readonly driving = new Map<string, Promise<void>>();
  /** Proofs one at a time: the proof server's memory, and the sponsor's own calls prove too. */
  readonly proverLane = new FifoLock();
  /** Withdrawal starts one at a time, until each one's Sepolia transfer is broadcast. */
  readonly withdrawalLane = new FifoLock();
  private readonly mpc = { lastSignatureAfterMs: null as number | null, timeouts: [] as number[] };
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  /** Opens between their checks and their record, so concurrent opens cannot pass the uniqueness
   *  and per-owner checks together (audit C11, F-B10). */
  private readonly admitting = {
    swaps: new Set<string>(),
    coins: new Set<string>(),
    owners: new Map<string, number>(),
    clients: new Map<string, number>(),
  };
  /** When each awaiting deposit address is read next, and was read last (ms; in memory: a restart
   *  reads them all once). */
  private readonly nextPoll = new Map<string, number>();
  private readonly lastPoll = new Map<string, number>();
  /** The client (IPv4 address or IPv6 /48) that opened or revived each unfunded swap: in memory only,
   *  never persisted (audit R4 per-client cap). */
  private readonly clientOf = new Map<string, string>();
  /** The owners' Sepolia balances an open read, reused for `ownerBalanceCacheMs`. */
  private readonly balanceCache = new Map<string, { value: bigint; at: number }>();
  private seq = 0;

  constructor(private readonly deps: SwapServiceDeps) {
    this.now = deps.now ?? Date.now;
    this.migrate();
  }

  /**
   * Records written before P4.2-fix2 (audit R3, R5): a failure that can be revived is marked
   * recoverable (the lifetime re-arm cap is gone; a failure without the field is read by its
   * reason), and a failed withdrawal attempt that named a request id without a known resolution
   * keeps its nonce until it is reconciled by that id.
   */
  private migrate(): void {
    for (const r of this.deps.store.all()) {
      let dirty = false;
      if (r.state === 'failed') {
        const recoverable = RECOVERABLE_FAILURES.includes(r.reason ?? '') || (r.recoverable ?? false);
        if (r.recoverable !== recoverable) {
          r.recoverable = recoverable;
          dirty = true;
        }
      }
      for (const w of r.withdrawals) {
        if (w.stage === 'failed' && w.requestId && w.resolution === undefined && w.unresolved === undefined) {
          w.unresolved = true;
          dirty = true;
        }
      }
      if (dirty) this.deps.store.put(r);
    }
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
    /** The caller's client key (IPv4 address or IPv6 /48), for the per-client cap. */
    client?: string;
  }): Promise<{ token: string; rec: SwapRecord; resumed: boolean }> {
    const { swapId, payload } = input;
    const client = input.client ?? 'unknown';
    const owner = getAddress(input.signer);
    if (getAddress(payload.evmAddress) !== owner) {
      throw new SwapError(401, 'unauthorised', 'the swap’s EVM address is not the signer', 'wrong-signer');
    }
    const existing = this.deps.store.get(swapId);
    if (existing) return this.reopen(existing, payload, owner, client);
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
    this.admitActive(owner);
    // Spending controls for a NEW swap (re-opens are exempt): swaps per address per day, swaps
    // waiting for funds overall and per client, and the daily DUST budget (audit C6, C7, R4).
    const dayAgo = this.nowS() - 86_400;
    const today =
      this.deps.store.all().filter((r) => r.evmAddress === owner && r.createdAt > dayAgo).length +
      (this.admitting.owners.get(owner) ?? 0);
    if (today >= this.cfg.maxSwapsPerOwnerPerDay) {
      throw new SwapError(
        429,
        SWAP_ERRORS.tooManySwaps,
        `this address has started ${today} swaps in the last 24 hours; try again later`,
      );
    }
    this.admitUnfunded(client);
    const be = this.deps.backend();
    if (!be) throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'the sponsor cannot bridge right now');

    // Reserve the swap id, the coin key, an owner slot and a client slot before the first await
    // (atomic admission).
    const release = this.reserveAdmission(swapId, payload.tempCoinPk, owner, client);
    try {
      return await this.admit(swapId, payload, owner, pay, receive, be, client);
    } finally {
      release();
    }
  }

  /** The owner's swaps in progress (and being admitted) stay under the cap. */
  private admitActive(owner: string): void {
    const active =
      this.deps.store.all().filter((r) => r.evmAddress === owner && !isTerminal(r.state)).length +
      (this.admitting.owners.get(owner) ?? 0);
    if (active >= this.cfg.maxActiveSwapsPerOwner) {
      throw new SwapError(
        429,
        SWAP_ERRORS.tooManySwaps,
        `this address already has ${active} swaps in progress; finish one first`,
      );
    }
  }

  /** One more swap that has received nothing: the global cap, the client's cap, and the budget. DUST
   *  is committed only once funds arrive, so an unfunded swap costs the budget nothing (audit R4). */
  private admitUnfunded(client: string): void {
    if (this.unfundedCount() + this.admitting.swaps.size >= this.cfg.maxUnfundedSwaps) {
      throw new SwapError(
        503,
        SWAP_ERRORS.sponsorBusy,
        'too many swaps are waiting for funds right now; try again later',
      );
    }
    const mine = this.unfundedOfClient(client) + (this.admitting.clients.get(client) ?? 0);
    if (mine >= this.cfg.maxUnfundedPerClient) {
      throw new SwapError(
        429,
        SWAP_ERRORS.tooManySwaps,
        `${mine} swaps from this network address are waiting for funds; fund or finish one first`,
        'client',
      );
    }
    if (this.overBudget(1)) {
      throw new SwapError(503, SWAP_ERRORS.sponsorBudget, 'the sponsor’s daily budget is spent; try again tomorrow');
    }
  }

  private reserveAdmission(swapId: string, coinPk: string | null, owner: string, client: string): () => void {
    const bump = (m: Map<string, number>, k: string, by: number) => {
      const n = (m.get(k) ?? 0) + by;
      if (n > 0) m.set(k, n);
      else m.delete(k);
    };
    this.admitting.swaps.add(swapId);
    if (coinPk) this.admitting.coins.add(coinPk);
    bump(this.admitting.owners, owner, 1);
    bump(this.admitting.clients, client, 1);
    return () => {
      this.admitting.swaps.delete(swapId);
      if (coinPk) this.admitting.coins.delete(coinPk);
      bump(this.admitting.owners, owner, -1);
      bump(this.admitting.clients, client, -1);
    };
  }

  private unfundedOfClient(client: string): number {
    let n = 0;
    for (const [swapId, c] of this.clientOf) {
      if (c !== client) continue;
      const r = this.deps.store.get(swapId);
      if (r && SwapService.unfunded(r)) n++;
      else this.clientOf.delete(swapId);
    }
    return n;
  }

  /** A Sepolia read reused for `ownerBalanceCacheMs` (an open's owner balances). */
  private async cachedRead(key: string, read: () => Promise<bigint>): Promise<bigint> {
    const now = this.now();
    const hit = this.balanceCache.get(key);
    if (hit && now - hit.at < this.cfg.ownerBalanceCacheMs) return hit.value;
    const value = await read();
    if (this.balanceCache.size > 5_000) {
      for (const [k, v] of this.balanceCache)
        if (now - v.at >= this.cfg.ownerBalanceCacheMs) this.balanceCache.delete(k);
    }
    this.balanceCache.set(key, { value, at: now });
    return value;
  }

  /**
   * The owner holds what the swap will ask it to send (audit R4, F-A21): the pay amount of the pay
   * token and the sweep's ETH. Read-only, cached briefly. An open that fails it costs the sponsor
   * one or two reads, and a spammer needs funded addresses.
   */
  private async checkOwnerFunds(be: SwapBackend, owner: string, leg: LegRecord, ethWei: bigint): Promise<void> {
    let token: bigint;
    let eth: bigint;
    try {
      [token, eth] = await Promise.all([
        this.cachedRead(`erc20:${leg.erc20Address.toLowerCase()}/${owner.toLowerCase()}`, () =>
          be.evm.erc20Balance(leg.erc20Address, owner),
        ),
        this.cachedRead(`eth:${owner.toLowerCase()}`, () => be.evm.ethBalance(owner)),
      ]);
    } catch {
      throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'Sepolia cannot be read right now; try again shortly');
    }
    if (token < BigInt(leg.amount)) {
      throw new SwapError(
        422,
        SWAP_ERRORS.insufficientFunds,
        `this address does not hold ${leg.amount} base units of ${leg.symbol} on Sepolia`,
        'token',
      );
    }
    if (eth < ethWei) {
      throw new SwapError(
        422,
        SWAP_ERRORS.insufficientFunds,
        'this address does not hold enough Sepolia ETH for the deposit’s sweep',
        'eth',
      );
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
    client: string,
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
    await this.checkOwnerFunds(be, owner, this.leg(pay, payload.pay.amount), gas.ethWei);
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
    this.clientOf.set(swapId, client);
    this.deps.log.info('swap opened', { swapId, offerId: rec.offerId, pay: pay.symbol, receive: receive.symbol });
    return { token, rec, resumed: false };
  }

  private async reopen(rec: SwapRecord, p: OpenSwapPayload, owner: string, client: string) {
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
    // A recoverable failure is revived first: its admission may refuse (the token then stays the
    // old one), or pace it (the answer says when: `retryAt`).
    let deferred = false;
    if (rec.state === 'failed' && rec.recoverable === true && rec.deposit) {
      deferred = !(await this.revive(rec, owner, client));
    }
    const { token, hash } = issueSwapToken(this.deps.random);
    rec.tokenHash = hash;
    const now = this.nowS();
    if (deferred) {
      this.deps.store.put(rec);
      this.deps.log.info('swap re-opened; its re-arm is paced', { swapId: rec.swapId, retryAt: rec.retryAt });
      return { token, rec, resumed: true };
    }
    rec.updatedAt = now;
    this.nudge(rec);
    // A swap still waiting for funds (or for the rest of a partial deposit): its sweep gas follows the
    // live base fee up (audit C2); the answer carries it, and the page tops the address up to it.
    const be = this.deps.backend();
    if ((rec.state === 'awaiting_funds' || rec.state === 'partial') && be) {
      const baseFee = await be.evm.baseFeePerGas().catch(() => null);
      if (baseFee !== null) this.raiseSweepGas(rec, baseFee);
    }
    this.deps.store.put(rec);
    this.deps.log.info('swap re-opened', { swapId: rec.swapId, state: rec.state });
    return { token, rec, resumed: true };
  }

  /**
   * Revive a recoverable failure (audit C5, R3, R4). Returns false when a deposit re-arm is paced
   * (`rec.retryAt` says when); throws when a swap that received nothing does not pass the admission
   * of a new open (the caps, the budget, the owner's Sepolia funds).
   */
  private async revive(rec: SwapRecord, owner: string, client: string): Promise<boolean> {
    const d = rec.deposit!;
    const now = this.nowS();
    if (rec.reason === 'funds-not-received') {
      // Funded (the WHOLE pay amount seen at the address, now or before): it simply waits again; its
      // DUST is committed only once the funds are all there. Anything less (audit S5): the same atomic
      // admission as a new open (the caps), and the owner's Sepolia funds when nothing arrived at all.
      const amount = BigInt(rec.pay.amount);
      let full = BigInt(d.maxSeen ?? '0') >= amount;
      const be = this.deps.backend();
      if (!be) throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'the sponsor cannot bridge right now');
      if (!full) {
        const there = await be.evm.erc20Balance(rec.pay.erc20Address, rec.depositAddress).catch(() => null);
        if (there === null) {
          throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'Sepolia cannot be read right now; try again');
        }
        d.atAddress = there.toString();
        if (there > 0n) d.seenAt ??= now;
        if (there > BigInt(d.maxSeen ?? '0')) d.maxSeen = there.toString();
        full = there >= amount;
      }
      if (!full) {
        if (this.admitting.swaps.has(rec.swapId)) {
          throw new SwapError(409, SWAP_ERRORS.conflict, 'this swap is being re-opened right now', 'in-progress');
        }
        this.admitActive(owner);
        this.admitUnfunded(client);
        const release = this.reserveAdmission(rec.swapId, null, owner, client);
        try {
          if (d.seenAt === undefined) await this.checkOwnerFunds(be, owner, rec.pay, BigInt(rec.sweepGas.ethWei));
        } finally {
          release();
        }
        // Admitted: the transition below runs before any other await (atomic with the checks).
        this.clientOf.set(rec.swapId, client);
      }
      if (rec.state !== 'failed') return true; // revived meanwhile
      transition(rec, 'awaiting_funds', this.nowS());
      pushStage(d, 'waiting-for-funds', this.nowS(), { reopened: 'true' });
      return true;
    }
    // The deposit failed with its funds at the address: a NEW startDeposit to the same recipient
    // moves them. Paced by a cooldown and a per-day count, never a lifetime cap (audit R3); its DUST
    // is admitted when it starts (audit R4).
    const at = this.rearmAt(d);
    if (at > now) {
      rec.retryAt = at;
      return false;
    }
    d.rearmTimes = [...(d.rearmTimes ?? []).filter((t) => t > now - 86_400), now];
    d.rearms = (d.rearms ?? 0) + 1;
    d.attempts = 0;
    delete d.requestId;
    delete d.requestAmount;
    delete d.startedAtMs;
    // A failed remainder deposit revives to `partial`: the wallet already holds part (audit S2).
    const back = mintedTotalOf(rec) > 0n ? 'partial' : 'awaiting_funds';
    transition(rec, back, now);
    pushStage(d, back === 'partial' ? 'partial' : 'waiting-for-funds', now, {
      reopened: 'true',
      rearm: String(d.rearms),
    });
    return true;
  }

  /** When a failed deposit may be re-armed next (unix seconds). */
  private rearmAt(d: DepositRecord): number {
    const now = this.nowS();
    const recent = (d.rearmTimes ?? []).filter((t) => t > now - 86_400).sort((a, b) => a - b);
    let at = recent.length > 0 ? recent.at(-1)! + this.cfg.depositRearmCooldownSeconds : now;
    const perDay = this.cfg.depositRearmsPerDay;
    if (recent.length >= perDay) at = Math.max(at, recent[recent.length - perDay]! + 86_400);
    return at;
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
    let makerId: string;
    try {
      maker = this.deps.makerImbalances(offer.offerBech32);
      makerId = this.deps.makerTxId(offer.offerBech32);
    } catch {
      throw mismatch('maker-tx', 'the offer’s transaction cannot be read');
    }
    // The kernel names an offer by the sha256 of its maker transaction's bytes: the bytes served
    // must be the offer this swap signed for, so the take is bound to that transaction (audit C4).
    if (makerId !== p.offerId) throw mismatch('maker-tx', 'the offer’s transaction is not the one its id names');
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

  /** A swap waiting for funds whose address has not shown the WHOLE pay amount yet: one base unit
   *  does not take a swap out of the unfunded caps (audit S5, F-A31). */
  private static unfunded(r: SwapRecord): boolean {
    return r.state === 'awaiting_funds' && BigInt(r.deposit?.maxSeen ?? '0') < BigInt(r.pay.amount);
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
      if (r.deposit) add(r.deposit.stages, ['completed', 'closed', 'abandoned', 'completed-foreign']);
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
          // Nothing is committed until the funds are all there and the deposit starts (audit R4).
          break;
        case 'depositing':
          total += (r.deposit?.requestId ? settle : start + settle) + start + settle;
          break;
        case 'minted':
        case 'taking':
        case 'taken':
        case 'partial':
          // The withdrawal still to come (a remainder deposit is admitted when it starts).
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

  /** Settles reserved for work queued now and not recorded yet (foreign completions; audit S6). */
  private reservedDust = 0n;

  /** Whether `newSwaps` more swaps, and `extra` specks of other work, would pass the daily DUST budget.
   *  Every reservation made before an await counts (audit S6). */
  private overBudget(newSwaps: number, extra = 0n): boolean {
    const budget = this.cfg.dailyDustBudgetSpecks;
    if (budget === 0n) return false;
    const perSwap = 2n * (this.cfg.dustPerStartSpecks + this.cfg.dustPerSettleSpecks);
    return this.spent24h() + this.committed() + this.reservedDust + extra + BigInt(newSwaps) * perSwap > budget;
  }

  /**
   * Reserve `specks` of the daily budget for work about to be queued (atomic: the check and the
   * reservation run before any await), or null when it does not fit. The returned release is called
   * once the work is done: its spend is then recorded by its stage (audit S6).
   */
  private reserveDust(specks: bigint): (() => void) | null {
    if (this.overBudget(0, specks)) return null;
    this.reservedDust += specks;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.reservedDust -= specks;
    };
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

  /**
   * The page is looking at this swap: read its deposit address sooner, but never closer than
   * `pollNudgeMinMs` to its last read, and never later than already planned: page reads cannot
   * reset the backoff (audit R4, F-B26).
   */
  nudge(rec: SwapRecord): void {
    if (rec.state !== 'awaiting_funds' && rec.state !== 'partial') return;
    const next = this.nextPoll.get(rec.swapId);
    if (next === undefined) return; // read on the next pass anyway
    const at = Math.max(this.now(), (this.lastPoll.get(rec.swapId) ?? 0) + this.cfg.pollNudgeMinMs);
    if (at < next) this.nextPoll.set(rec.swapId, at);
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
    // In `partial`, only a Bridge back of what arrived (audit S2).
    if (rec.state === 'partial') {
      if (kind === 'swap') {
        throw new SwapError(
          409,
          SWAP_ERRORS.wrongState,
          'only part of the deposit arrived: wait for the rest, or bridge back what arrived',
          'partial',
        );
      }
      const held = heldOf(rec);
      if (held <= 0n) {
        throw new SwapError(
          409,
          SWAP_ERRORS.wrongState,
          'nothing of the deposit is in the temporary wallet yet',
          'partial',
        );
      }
      return { ...rec.pay, amount: held.toString() };
    }
    // Either kind in minted / taking / taken: a startWithdraw spends the coin the temporary wallet
    // really holds, so a mistaken "taken" report cannot make the vault pay twice (audit C13).
    return kind === 'swap' ? rec.receive : rec.pay;
  }

  // ── The vault account's nonces (audit C2, C3) ─────────────────────────────

  /**
   * Every withdrawal that holds its EVM nonce (persisted: they survive restarts): a started one that
   * has not settled, and one whose submission's outcome is unknown, current or superseded (audit C3,
   * R5). A replacement's competitors are read from here with BOTH fee fields (audit R2).
   */
  reservations(): Reservation[] {
    const out: Reservation[] = [];
    for (const r of this.deps.store.all()) {
      const current = currentWithdrawal(r);
      const running = r.state === 'withdrawing' || r.state === 'bridging_back';
      for (const w of r.withdrawals) {
        if (!w.requestId) continue;
        const uncertain = isUnresolved(w);
        let startedAtMs: number | undefined;
        if (uncertain) startedAtMs = w.uncertainSinceMs ?? w.submittedAtMs ?? 0;
        else if (w === current && running && !['completed', 'refunded', 'failed'].includes(w.stage)) {
          startedAtMs = w.startedAtMs ?? (w.startTx || w.startTxId ? 0 : undefined);
        }
        if (startedAtMs === undefined) continue;
        const g = gasOf(w.gas, this.cfg.bridgeGas);
        const sf = w.signedFees;
        const max = (a: bigint, b: string | undefined) => (b !== undefined && BigInt(b) > a ? BigInt(b) : a);
        out.push({
          swapId: r.swapId,
          nonce: BigInt(w.evmNonce),
          signed: w.signedAtMs !== undefined,
          mined: w.minedAtMs !== undefined || w.sepoliaTx !== undefined,
          startedAtMs,
          ...(w.signedAtMs !== undefined ? { signedAtMs: w.signedAtMs } : {}),
          maxFeePerGas: max(g.maxFeePerGas, sf?.maxFeePerGas),
          maxPriorityFeePerGas: max(g.maxPriorityFeePerGas, sf?.maxPriorityFeePerGas),
          uncertain,
        });
      }
    }
    return out;
  }

  /**
   * Stuck: never signed long after its start, or signed, not mined long after, and priced under the
   * live base fee. The MPC never attests such a transfer (the plan's C2 research), so the NEXT
   * withdrawal takes its nonce: whichever of the two is mined, the other is attested never executed
   * and refunded. With `baseFee` unknown, a signed transfer is judged by its age alone. A submission
   * whose outcome is unknown is never stuck: it is reconciled by its request id (audit R5).
   */
  private isStuck(r: Reservation, baseFee: bigint | null): boolean {
    if (r.uncertain) return false;
    const now = this.now();
    if (!r.signed) return now - r.startedAtMs > this.cfg.unsignedStaleMs;
    if (r.mined) return false;
    if (now - (r.signedAtMs ?? r.startedAtMs) <= this.cfg.stuckTransferMs) return false;
    return baseFee === null || baseFee + this.cfg.bridgeGas.maxPriorityFeePerGas > r.maxFeePerGas;
  }

  /** The nonce the head of the withdrawal lane signs: a stuck reservation's (a replacement, with the
   *  transfers it must outbid), or the account's pending nonce past every live reservation. */
  private async laneNonce(be: SwapBackend): Promise<LaneNonce> {
    const [pending, latest, baseFee] = await Promise.all([
      be.evm.nonce(be.vaultEvmAddress, 'pending'),
      be.evm.nonce(be.vaultEvmAddress, 'latest'),
      be.evm.baseFeePerGas().catch(() => null),
    ]);
    const live = this.reservations().filter((r) => r.nonce >= latest);
    const stuck = live
      .filter((r) => this.isStuck(r, baseFee))
      .map((r) => r.nonce)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const n of stuck) {
      if (!live.some((r) => r.nonce === n && !this.isStuck(r, baseFee))) {
        return { nonce: n, competing: live.filter((r) => r.nonce === n) };
      }
    }
    let next = pending;
    for (const r of live) if (r.nonce + 1n > next) next = r.nonce + 1n;
    return { nonce: next, competing: [] };
  }

  /** The nonce a withdrawal asking now should sign: the lane's, past the withdrawals ahead of it. */
  private async nextWithdrawNonce(be: SwapBackend): Promise<LaneNonce> {
    const ahead = this.withdrawalLane.running + this.withdrawalLane.waiting;
    const lane = await this.laneNonce(be);
    return ahead === 0 ? lane : { nonce: lane.nonce + BigInt(ahead), competing: [] };
  }

  /** The reservations as /health reports them (stuck judged by age: no chain read). */
  reservationsStatus(): {
    nonce: string;
    swapId: string;
    signed: boolean;
    mined: boolean;
    stuck: boolean;
    uncertain: boolean;
    sinceSeconds: number;
  }[] {
    const now = this.now();
    return this.reservations().map((r) => ({
      nonce: r.nonce.toString(),
      swapId: r.swapId,
      signed: r.signed,
      mined: r.mined,
      stuck: this.isStuck(r, null),
      uncertain: r.uncertain,
      sinceSeconds: Math.max(0, Math.round((now - r.startedAtMs) / 1000)),
    }));
  }

  /** `x` raised by the replacement increment, rounded up (then to 0.1 gwei). */
  private bumped(x: bigint): bigint {
    const pct = 100n + this.cfg.replacementBumpPercent;
    return ceilTenthGwei((x * pct + 99n) / 100n);
  }

  /**
   * A withdrawal's transfer gas, sized now: max(the floor, 2 × base fee + tip), at most the cap. A
   * replacement (audit R2, F-B22) outbids EVERY transfer already holding its nonce on BOTH fee fields
   * by the pools' replacement increment (≥ 10%, rounded up): a pool refuses a replacement that raises
   * only the fee cap, so both transfers would hang.
   */
  private withdrawGasFor(baseFee: bigint, competing: readonly Reservation[] = []): EvmGasPolicy {
    const p = this.cfg.bridgeGas;
    let tip = p.maxPriorityFeePerGas;
    let floor = p.maxFeePerGas;
    for (const c of competing) {
      const t = this.bumped(c.maxPriorityFeePerGas);
      if (t > tip) tip = t;
      const f = this.bumped(c.maxFeePerGas);
      if (f > floor) floor = f;
    }
    const live = ceilTenthGwei(2n * baseFee + tip);
    const maxFeePerGas = live > floor ? live : floor;
    if (maxFeePerGas > this.cfg.bridgeMaxFeeCapWei) {
      throw new SwapError(
        503,
        SWAP_ERRORS.bridgeUnavailable,
        'Sepolia gas is unusually expensive right now; try again later',
      );
    }
    return { ...p, maxFeePerGas, maxPriorityFeePerGas: tip };
  }

  /** Whether `gas` outbids every competing transfer on both fee fields (a pool accepts it). */
  private outbids(gas: EvmGasPolicy, competing: readonly Reservation[]): boolean {
    return competing.every(
      (c) =>
        gas.maxFeePerGas >= this.bumped(c.maxFeePerGas) &&
        gas.maxPriorityFeePerGas >= this.bumped(c.maxPriorityFeePerGas),
    );
  }

  async withdrawParams(rec: SwapRecord, kind: WithdrawKind): Promise<WithdrawParams> {
    this.withdrawLeg(rec, kind);
    const be = this.deps.backend();
    if (!be) throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'the sponsor cannot bridge right now');
    // An earlier attempt that may still land holds the swap's coin and a nonce: settle it first (audit R5).
    await this.settleEarlierAttempts(rec, be);
    const leg = this.withdrawLeg(rec, kind);
    let lane: LaneNonce;
    let baseFee: bigint;
    try {
      [lane, baseFee] = await Promise.all([this.nextWithdrawNonce(be), be.evm.baseFeePerGas()]);
    } catch {
      throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'Sepolia cannot be read right now; try again shortly');
    }
    const g = this.withdrawGasFor(baseFee, lane.competing);
    // Remember what was handed out: /prove rebuilds with this gas, and tells a vault that moved
    // since (409) from a wrong call.
    const vaultMark = await be.vaultStateMark().catch(() => undefined);
    rec.withdrawOffer = {
      kind,
      evmNonce: lane.nonce.toString(),
      gas: gasRecord(g),
      ...(vaultMark ? { vaultMark } : {}),
      at: this.nowS(),
    };
    this.persist(rec);
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
      evmNonce: lane.nonce.toString(),
      vaultAddress: be.vaultAddress,
    };
  }

  /**
   * Before a new withdrawal attempt is authorised, every earlier attempt of this swap whose outcome
   * is unknown is settled by its request id (audit R5, F-B28): one that landed is adopted (it runs;
   * the new attempt is refused), one that provably did not land is closed, and while one may still
   * land no new attempt may take a nonce or the coin (409 `withdrawal-in-progress`).
   */
  private async settleEarlierAttempts(rec: SwapRecord, be: SwapBackend): Promise<void> {
    const nowMs = this.now();
    // The attempts whose outcome is unknown, and those judged not included that are still re-checked
    // (one found in the vault now is adopted instead of a new attempt; audit S1).
    const pending = rec.withdrawals.filter((w) => isUnresolved(w) || isRecheck(w, nowMs));
    if (pending.length === 0) return;
    let open: OpenRequests;
    try {
      open = await be.openRequests('withdraw');
    } catch {
      throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'the vault cannot be read right now; try again shortly');
    }
    for (const w of pending) {
      const wasRecheck = isRecheck(w, nowMs);
      const outcome = await this.reconcileAttempt(rec, w, be, open);
      if (outcome === 'adopted') {
        this.spawn(rec.swapId, () => this.resumeWithdraw(rec.swapId));
        throw new SwapError(
          409,
          SWAP_ERRORS.withdrawalInProgress,
          'an earlier withdrawal of this swap landed after all: it is running now',
          'adopted',
        );
      }
      if (outcome === 'uncertain' && !wasRecheck) {
        throw new SwapError(
          409,
          SWAP_ERRORS.withdrawalInProgress,
          'an earlier withdrawal of this swap may still land: wait until the sponsor has settled it',
          'uncertain',
        );
      }
    }
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

  /** Prove on the proof server. `ticket.dispatched` is set once the work is handed to it: failed work
   *  is not given back to the daily budget (audit R3, F-B27). */
  private async proveOnServer(bytes: Uint8Array, ticket: ProofTicket): Promise<Uint8Array> {
    const prover = this.deps.prover();
    if (!prover) throw new SwapError(503, SWAP_ERRORS.proverUnavailable, 'the proof server is not available');
    const release = await this.proverLane.acquire(`p${++this.seq}`);
    try {
      ticket.dispatched = true;
      return await prover.prove(bytes);
    } catch (e) {
      this.deps.log.warn('proof failed', { error: e });
      throw new SwapError(503, SWAP_ERRORS.proverUnavailable, 'the proof server could not prove this transaction');
    } finally {
      release();
    }
  }

  private rebuildArgs(rec: SwapRecord, leg: LegRecord, coinNonce: string, evmNonce: bigint, gas: EvmGasPolicy) {
    return {
      evmNonce,
      gas,
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

  /**
   * The commitments of the coins the page says the transaction pays to the temporary wallet (audit
   * R1): each recomputed with the temporary coin public key, so a coin can only count as the
   * wallet's if it really is. Only this swap's colours.
   */
  private walletCommitments(rec: SwapRecord, outs: readonly WalletOutput[] | undefined): WalletCommitments {
    const set = new Set<string>();
    const colours = [rec.pay.colour, rec.receive.colour];
    for (const o of outs ?? []) {
      if (!colours.includes(o.colour)) {
        throw new SwapError(
          422,
          SWAP_ERRORS.invalidTx,
          'a disclosed wallet output is not of this swap’s tokens',
          'another-colour',
        );
      }
      let c: string;
      try {
        c = this.deps.coinCommitment({ nonce: o.nonce, colour: o.colour, value: BigInt(o.value) }, rec.tempCoinPk);
      } catch {
        throw new SwapError(
          422,
          SWAP_ERRORS.invalidTx,
          'a disclosed wallet output cannot be read',
          'undisclosed-output',
        );
      }
      set.add(c.replace(/^0x/i, '').toLowerCase());
    }
    return set;
  }

  /** Validate and prove; returns the proven (pre-binding) transaction's bytes. */
  async prove(rec: SwapRecord, req: ProveRequest & { kind?: WithdrawKind }): Promise<Uint8Array> {
    // The budget slot is taken before the first await, so concurrent requests cannot pass the
    // budget together (audit C11, F-B10). It is given back if nothing reached the proof server;
    // work the proof server did and failed stays counted in the daily budget (audit R3, F-B27).
    const ticket: ProofTicket = { entry: this.reserveProof(rec, req.purpose), dispatched: false };
    let proven = false;
    try {
      if (!this.deps.prover())
        throw new SwapError(503, SWAP_ERRORS.proverUnavailable, 'the proof server is not available');
      const bytes = hexBytes(req.tx);
      const summary = this.inspect(bytes, 'unproven');
      const wallet = this.walletCommitments(rec, req.walletOutputs);
      const out =
        req.purpose === 'take'
          ? await this.proveTake(rec, bytes, summary, wallet, ticket)
          : await this.proveWithdraw(rec, bytes, summary, req, wallet, ticket);
      proven = true;
      return out;
    } finally {
      if (!proven) {
        if (ticket.dispatched) this.proofFailed(rec, ticket.entry);
        else this.refundProof(rec, ticket.entry.id);
      }
    }
  }

  /**
   * One more proof of `purpose` for this swap, within the budgets (audit C11, R3): at most
   * `proofsPerSwap` takes and `proofsPerSwap` withdraw proofs per attempt, and `proofsPerSwapPerDay`
   * of all kinds, each counted over the last 24 hours: a budget that is spent comes back over time
   * (Retry-After), it never strands the swap.
   */
  private reserveProof(rec: SwapRecord, purpose: 'take' | 'withdraw'): ProofEntry {
    const now = this.nowS();
    const day = now - 86_400;
    const log = (rec.proofs.log ?? []).filter((e) => e.at > day);
    rec.proofs.log = log;
    const wait = (times: number[], limit: number) =>
      Math.max(1, [...times].sort((a, b) => a - b)[times.length - limit]! + 86_400 - now);
    const per = this.cfg.proofsPerSwap;
    if (purpose === 'take') {
      const takes = log.filter((e) => e.purpose === 'take' && !e.failed).map((e) => e.at);
      if (takes.length >= per) {
        throw new SwapError(
          429,
          SWAP_ERRORS.proofBudget,
          `this swap has used its ${per} take proofs of the last 24 hours`,
          undefined,
          wait(takes, per),
        );
      }
    } else {
      const since = Math.max(day, rec.proofs.withdrawSince ?? 0);
      const mine = log.filter((e) => e.purpose === 'withdraw' && !e.failed && e.at > since).map((e) => e.at);
      if (mine.length >= per) {
        throw new SwapError(
          429,
          SWAP_ERRORS.proofBudget,
          `this withdrawal attempt has used its ${per} proofs (they come back over 24 hours)`,
          undefined,
          wait(mine, per),
        );
      }
    }
    const all = log.map((e) => e.at);
    if (all.length >= this.cfg.proofsPerSwapPerDay) {
      throw new SwapError(
        429,
        SWAP_ERRORS.proofBudget,
        `this swap has used its ${this.cfg.proofsPerSwapPerDay} proofs of the last 24 hours`,
        undefined,
        wait(all, this.cfg.proofsPerSwapPerDay),
      );
    }
    const total = rec.proofs.total ?? rec.proofs.take + rec.proofs.withdraw;
    const entry: ProofEntry = { id: Math.max(total, ...log.map((e) => e.id)) + 1, at: now, purpose };
    log.push(entry);
    rec.proofs[purpose]++;
    rec.proofs.total = total + 1;
    return entry;
  }

  /** Nothing reached the proof server: the slot is given back entirely. */
  private refundProof(rec: SwapRecord, id: number | undefined): void {
    const log = rec.proofs.log ?? [];
    const i = log.findIndex((e) => e.id === id);
    if (i < 0) return;
    const [e] = log.splice(i, 1);
    rec.proofs[e!.purpose] = Math.max(0, rec.proofs[e!.purpose] - 1);
    rec.proofs.total = Math.max(0, (rec.proofs.total ?? 1) - 1);
    this.persist(rec);
  }

  /** The proof server failed this work: it stays in the daily budget; the purpose's slot comes back. */
  private proofFailed(rec: SwapRecord, entry: ProofEntry): void {
    const e = (rec.proofs.log ?? []).find((x) => x.id === entry.id);
    if (e && !e.failed) {
      e.failed = true;
      rec.proofs[e.purpose] = Math.max(0, rec.proofs[e.purpose] - 1);
    }
    this.persist(rec);
  }

  /** A new withdrawal attempt: its own proof budget (audit C11). */
  private newWithdrawAttempt(rec: SwapRecord): void {
    rec.proofs.withdraw = 0;
    rec.proofs.withdrawSince = this.nowS();
  }

  private async proveTake(
    rec: SwapRecord,
    bytes: Uint8Array,
    summary: TxSummary,
    wallet: WalletCommitments,
    ticket: ProofTicket,
  ): Promise<Uint8Array> {
    if (rec.state !== 'minted' && rec.state !== 'taking') {
      throw new SwapError(409, SWAP_ERRORS.wrongState, `a take is not possible while the swap is ${rec.state}`);
    }
    // Every output is the temporary wallet's (audit R1). ACCEPTED: the proof cannot name the maker
    // transaction it will be merged with, only its terms (../validate/rules.ts header): the batcher
    // pays the take and the coins are the wallet's own, so that costs the sponsor proof time only.
    this.judge(() =>
      validateTake(
        summary,
        {
          pay: { colour: rec.pay.colour, amount: BigInt(rec.pay.amount) },
          receive: { colour: rec.receive.colour, amount: BigInt(rec.receive.amount) },
        },
        { walletOutputs: wallet },
      ),
    );
    const status = await this.deps.offers.status(rec.offerId).catch(() => 'unknown' as const);
    if (['consumed', 'expired', 'cancelled', 'not_found'].includes(status)) {
      throw new SwapError(409, SWAP_ERRORS.offerNotAvailable, `the offer is ${status}: Swap is not available`, status);
    }
    if (rec.state === 'minted') transition(rec, 'taking', this.nowS());
    rec.updatedAt = this.nowS();
    this.deps.store.put(rec);
    return this.proveOnServer(bytes, ticket);
  }

  private async proveWithdraw(
    rec: SwapRecord,
    bytes: Uint8Array,
    summary: TxSummary,
    req: Extract<ProveRequest, { purpose: 'withdraw' }> & { kind?: WithdrawKind },
    wallet: WalletCommitments,
    ticket: ProofTicket,
  ): Promise<Uint8Array> {
    const be = this.deps.backend();
    if (!be) throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'the sponsor cannot bridge right now');
    // Refuse before proving what the sponsor could not submit now (audit R3, F-A23): the proof
    // would be spent for nothing.
    this.sponsorReady();
    await this.settleEarlierAttempts(rec, be);
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
      next = (await this.nextWithdrawNonce(be)).nonce;
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
    // The gas the latest withdraw-params handed out (the policy floor for a page that skipped it).
    const offeredGas = gasOf(rec.withdrawOffer?.gas, this.cfg.bridgeGas);
    // The kind the page named, or both in the likelier order (the swap's own token after a take).
    const kinds: WithdrawKind[] = req.kind
      ? [req.kind]
      : rec.state === 'partial'
        ? ['bridge-back']
        : rec.state === 'taken' || rec.takeTx
          ? ['swap', 'bridge-back']
          : ['bridge-back', 'swap'];
    // The approval keeps the whole proof-erased transaction: /withdraw compares it byte for byte
    // (audit R1, S8).
    if (summary.erased === undefined) {
      throw new SwapError(422, SWAP_ERRORS.invalidTx, 'the transaction could not be read', 'not-a-transaction');
    }
    let firstError: unknown = null;
    for (const kind of kinds) {
      const leg = this.withdrawLeg(rec, kind);
      let rebuilt;
      try {
        rebuilt = await be.rebuildWithdraw(this.rebuildArgs(rec, leg, req.coinNonce, evmNonce, offeredGas));
      } catch (e) {
        this.deps.log.warn('withdraw rebuild failed', { swapId: rec.swapId, error: e });
        throw new SwapError(
          503,
          SWAP_ERRORS.bridgeUnavailable,
          'the vault cannot be read right now; try again shortly',
        );
      }
      try {
        this.judge(() => validateWithdraw(summary, rebuilt, leg.colour, { walletOutputs: wallet }));
      } catch (e) {
        firstError ??= e;
        continue;
      }
      rec.provenWithdraw = {
        v: PROVEN_WITHDRAW_VERSION,
        kind,
        amount: leg.amount,
        callsDigest: summary.callsDigest,
        structureDigest: summary.structureDigest,
        erased: summary.erased,
        proofId: ticket.entry.id,
        coinNonce: req.coinNonce,
        evmNonce: evmNonce.toString(),
        gas: gasRecord(offeredGas),
        at: this.nowS(),
      };
      if (kind === 'swap' && rec.state === 'taking') transition(rec, 'taken', this.nowS());
      rec.updatedAt = this.nowS();
      this.deps.store.put(rec);
      return this.proveOnServer(bytes, ticket);
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
    // An earlier attempt that may still land keeps the coin and its nonce (audit R5).
    if (rec.withdrawals.some(isUnresolved)) {
      throw new SwapError(
        409,
        SWAP_ERRORS.withdrawalInProgress,
        'an earlier withdrawal of this swap may still land: wait until the sponsor has settled it',
        'uncertain',
      );
    }
    const proven = rec.provenWithdraw;
    if (!proven) throw new SwapError(409, SWAP_ERRORS.notProven, 'prove this withdrawal on the sponsor first');
    if (proven.v !== PROVEN_WITHDRAW_VERSION || proven.erased === undefined || proven.structureDigest === undefined) {
      // Approved by an older sponsor, under older rules (no wallet-output check, no whole-transaction
      // comparison): never honoured. The page rebuilds and proves again (audit S8).
      rec.provenWithdraw = null;
      this.refundProof(rec, proven.proofId);
      throw new SwapError(
        409,
        SWAP_ERRORS.staleVaultState,
        'this withdrawal was approved by an older sponsor: rebuild it and prove it again',
        'approval-outdated',
      );
    }
    const bytes = hexBytes(txHex);
    const summary = this.inspect(bytes, 'final');
    if (
      summary.callsDigest !== proven.callsDigest ||
      summary.structureDigest !== proven.structureDigest ||
      summary.erased !== proven.erased
    ) {
      // EXACTLY the transaction /prove validated, byte for byte once proofs and the binding are
      // erased: every input, output, recipient ciphertext, call and transcript (audit C4, R1).
      throw new SwapError(409, SWAP_ERRORS.notProven, 'this is not the withdrawal the sponsor proved');
    }
    const leg = this.withdrawLeg(rec, proven.kind);
    if (proven.amount !== undefined && proven.amount !== leg.amount) {
      // What the temporary wallet holds changed since the proof (a partial deposit moved on).
      rec.provenWithdraw = null;
      this.refundProof(rec, proven.proofId);
      throw new SwapError(
        409,
        SWAP_ERRORS.staleVaultState,
        'the amount to withdraw changed since this withdrawal was proven: rebuild it',
        'amount-changed',
      );
    }
    this.judge(() => validateWithdraw(summary, { calls: summary.calls, callsDigest: proven.callsDigest }, leg.colour));
    try {
      if (!this.deps.backend())
        throw new SwapError(503, SWAP_ERRORS.bridgeUnavailable, 'the sponsor cannot bridge right now');
      this.sponsorReady();
    } catch (e) {
      // A transient refusal: the proof this withdrawal took is given back (audit R3, F-A23), and the
      // same proven transaction may be sent again once the sponsor can pay.
      this.refundProof(rec, proven.proofId);
      throw e;
    }

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
      ...(proven.gas ? { gas: proven.gas } : {}),
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
    // The lane orders the head-of-lane checks and the submission; once the start is on chain the
    // withdrawal's persisted record holds its nonce (a reservation), so the lane is released there,
    // never held while the transfer waits for the MPC or for Sepolia (audit C2, C3). An uncertain
    // submission keeps its nonce the same way (audit R5).
    const release = await this.withdrawalLane.acquire(swapId);
    let released = false;
    const releaseLane = () => {
      if (released) return;
      released = true;
      release();
    };
    let started = false;
    let uncertain = false;
    try {
      this.stage(rec, w, 'starting');
      // The attempt's own amount: a Bridge back from `partial` moves what arrived (audit S2).
      const leg = { ...(w.kind === 'swap' ? rec.receive : rec.pay), amount: w.amount };
      const evmNonce = BigInt(w.evmNonce);
      const gas = gasOf(w.gas, this.cfg.bridgeGas);
      const [lane, vaultEthWei, vaultErc20, baseFee] = await Promise.all([
        this.laneNonce(be),
        be.evm.ethBalance(be.vaultEvmAddress),
        be.evm.erc20Balance(leg.erc20Address, be.vaultEvmAddress),
        be.evm.baseFeePerGas(),
      ]);
      if (lane.nonce !== evmNonce) {
        throw new DriveError(
          SWAP_ERRORS.staleEvmNonce,
          `the vault account's next nonce is now ${lane.nonce}, not ${evmNonce}: rebuild the withdrawal`,
        );
      }
      if (baseFee + gas.maxPriorityFeePerGas > gas.maxFeePerGas) {
        throw new DriveError(
          'stale-gas',
          'Sepolia’s base fee rose above this withdrawal’s fee cap: rebuild it with the current fee',
        );
      }
      // A replacement must outbid every transfer holding its nonce on both fee fields, or the pool
      // refuses it and both hang (audit R2).
      if (!this.outbids(gas, lane.competing)) {
        throw new DriveError(
          'stale-gas',
          'another transfer holds this nonce at a higher fee now: rebuild the withdrawal with the current fee',
        );
      }
      const pre = withdrawPreflight({ vaultEthWei, vaultErc20, amount: BigInt(leg.amount), gas });
      if (!pre.ok) throw new DriveError(BRIDGE_ERRORS.preflight, pre.problems.join('; '));
      const rebuilt = await be.rebuildWithdraw(this.rebuildArgs(rec, leg, w.coinNonce, evmNonce, gas));
      const summary = this.deps.inspect(bytes, 'final');
      if (rebuilt.callsDigest !== summary.callsDigest) {
        throw new DriveError(
          SWAP_ERRORS.staleVaultState,
          'the vault moved since this withdrawal was built: rebuild it',
        );
      }
      w.requestId = rebuilt.requestId;
      w.submittedAtMs = this.now();
      this.stage(rec, w, 'submitting', { requestId: rebuilt.requestId });
      let facts: MidnightTxFacts | null = null;
      let unknown: string | null = null;
      try {
        facts = await this.withProver(() =>
          be.submitWithdraw(bytes, {
            // Recorded before the node sees it: "not included" is judged against it (audit S1).
            onExpiry: (t) => {
              w.expiresAtMs = t;
              this.persist(rec);
            },
          }),
        );
      } catch (e) {
        // Before the node (the DUST balancing): nothing can land, a conclusive failure.
        if (e instanceof NotSubmittedError) throw new DriveError('withdraw-not-submitted', e.message);
        unknown = e instanceof Error ? e.message : String(e);
      }
      if (facts && facts.status !== 'SucceedEntirely') {
        if (facts.status === 'FailEntirely') {
          throw new DriveError('withdraw-start-failed', 'the withdrawal failed on chain: nothing moved');
        }
        unknown = `the node reported ${facts.status}`;
      }
      if (unknown !== null) {
        // The outcome is unknown: the request id tells whether it landed. Until it does, or until it
        // provably did not, the attempt keeps its nonce (audit R5, F-B28).
        const open = await be.openRequests('withdraw').catch(() => null);
        if (!open?.ids.includes(rebuilt.requestId)) {
          uncertain = true;
          this.markUncertain(rec, w, unknown);
          releaseLane();
          return;
        }
        facts = { txId: facts?.txId ?? '', txHash: facts?.txHash ?? null, status: 'SucceedEntirely' };
      }
      started = true;
      w.startedAtMs = this.now();
      if (facts!.txHash) w.startTx = facts!.txHash;
      if (facts!.txId) w.startTxId = facts!.txId;
      this.stage(rec, w, 'started', { requestId: rebuilt.requestId, ...(facts!.txHash ? { tx: facts!.txHash } : {}) });
      releaseLane(); // the persisted record now holds the nonce
      await this.relayAndSettleWithdraw(swapId, be, false);
    } catch (e) {
      if (uncertain) this.deps.log.warn('uncertain withdrawal: reconcile failed', { swapId, error: e });
      else if (!started) this.withdrawFailed(rec, w, e);
      else this.withdrawStalled(rec, w, e);
    } finally {
      releaseLane();
    }
  }

  /** A submission whose outcome is unknown (audit R5): the swap keeps waiting in `withdrawing` /
   *  `bridging_back`, the attempt keeps its nonce, and reconciliation settles it by its request id. */
  private markUncertain(rec: SwapRecord, w: WithdrawRecord, why: string): void {
    this.deps.log.warn('withdrawal submission uncertain', { swapId: rec.swapId, requestId: w.requestId, why });
    w.uncertainSinceMs = w.submittedAtMs ?? this.now();
    // Unknown expiry (the balancing never reported it): it was made before now, so it expires within
    // one time to live from now at the latest (audit S1).
    w.expiresAtMs ??= this.now() + WITHDRAW_TX_TTL_MS;
    w.error = {
      code: 'submission-uncertain',
      message: 'the withdrawal was sent but its outcome is not known yet; the sponsor is checking the vault',
    };
    pushStage(w, 'submission-uncertain', this.nowS(), { requestId: w.requestId! });
    this.persist(rec);
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
  private withdrawFailed(
    rec: SwapRecord,
    w: WithdrawRecord,
    e: unknown,
    resolution: WithdrawRecord['resolution'] = 'not-submitted',
  ): void {
    const code = e instanceof DriveError || e instanceof SwapError ? e.code : 'internal-error';
    const message =
      e instanceof DriveError || e instanceof SwapError ? e.message : 'the sponsor could not start this withdrawal';
    if (!(e instanceof DriveError)) this.deps.log.warn('withdrawal start failed', { swapId: rec.swapId, error: e });
    w.error = { code, message };
    w.resolution = code === 'withdraw-start-failed' ? 'failed-on-chain' : resolution;
    delete w.unresolved;
    pushStage(w, 'failed', this.nowS(), { code });
    if ((rec.state === 'withdrawing' || rec.state === 'bridging_back') && w === currentWithdrawal(rec)) {
      transition(rec, this.backAfter(rec, w), this.nowS());
    }
    this.newWithdrawAttempt(rec); // the next attempt gets a fresh budget (audit C11)
    this.persist(rec);
  }

  /** Where a withdrawal that moved nothing leaves the swap: the wallet holds the coin again, so
   *  `minted`, or `partial` for a Bridge back of a partial deposit (audit S2). */
  private backAfter(rec: SwapRecord, w: WithdrawRecord): 'minted' | 'partial' {
    return w.kind === 'swap' ? 'minted' : holdingState(rec);
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

  /** Move `w` to the end of the swap's withdrawals: it is the one that runs now. */
  private makeCurrent(rec: SwapRecord, w: WithdrawRecord): void {
    const i = rec.withdrawals.indexOf(w);
    if (i >= 0 && i !== rec.withdrawals.length - 1) {
      rec.withdrawals.splice(i, 1);
      rec.withdrawals.push(w);
    }
  }

  /** When each re-checked attempt's attestation was last read (ms; in memory). */
  private readonly recheckReads = new Map<string, number>();

  /**
   * Settle one attempt whose outcome is unknown by its request id (audit R5, F-B28, S1):
   *  - the request is open in the vault: it landed; ADOPT it (the swap runs it; the caller drives it);
   *  - it is not open but attested: it landed and was settled already (by anyone: the settles are
   *    permissionless), so its outcome is the attestation's;
   *  - neither, from a vault read at an indexer block past the transaction's expiry plus a margin,
   *    and `uncertainWindowMs` after it was sent: it did not land (a transaction cannot be included
   *    after its DUST intent's time to live, and the read covers that moment): NOT INCLUDED, the swap
   *    may retry. A read that does not cover the expiry (a lagging indexer), or an attestation lookup
   *    that fails, never decides it (audit S1);
   *  - otherwise it stays uncertain, and keeps its nonce.
   * An attempt judged not included is re-checked for `recheckMs` (its attestation at most every
   * RECHECK_ATTESTATION_MS): if its request appears after all, it is adopted, and the nonce it shares
   * with a later withdrawal is settled by the replacement rule (one mines, the other is refunded).
   */
  private async reconcileAttempt(
    rec: SwapRecord,
    w: WithdrawRecord,
    be: SwapBackend,
    open?: OpenRequests,
  ): Promise<'adopted' | 'settled' | 'not-included' | 'uncertain'> {
    const id = w.requestId!;
    const reqs = open ?? (await be.openRequests('withdraw'));
    const now = this.nowS();
    const nowMs = this.now();
    const recheck = isRecheck(w, nowMs);
    const current = w === currentWithdrawal(rec);
    const running = rec.state === 'withdrawing' || rec.state === 'bridging_back';
    if (reqs.ids.includes(id)) {
      // Another attempt of this swap running now keeps its place; this one waits (still reserved).
      if (running && !current) return 'uncertain';
      if (!running && !WALLET_HOLDS_FUNDS.includes(rec.state)) {
        this.deps.log.warn('a withdrawal request of a finished swap is open in the vault', {
          swapId: rec.swapId,
          requestId: id,
        });
        return 'uncertain';
      }
      if (recheck) {
        this.deps.log.warn('a withdrawal judged not included landed after all: adopted', {
          swapId: rec.swapId,
          requestId: id,
          evmNonce: w.evmNonce,
        });
      }
      delete w.error;
      delete w.unresolved;
      delete w.resolution;
      delete w.uncertainSinceMs;
      delete w.recheckUntilMs;
      this.recheckReads.delete(id);
      w.startedAtMs ??= this.now();
      pushStage(w, 'adopted', now, { requestId: id });
      this.makeCurrent(rec, w);
      if (!running) transition(rec, w.kind === 'swap' ? 'withdrawing' : 'bridging_back', now);
      this.persist(rec);
      return 'adopted';
    }
    if (recheck) {
      const last = this.recheckReads.get(id);
      if (last !== undefined && nowMs - last < RECHECK_ATTESTATION_MS) return 'not-included';
      this.recheckReads.set(id, nowMs);
    }
    let att: Attestation | null;
    try {
      att = await be.attestation('withdraw', id);
    } catch (e) {
      // A lookup that failed says nothing about the request (audit S1).
      this.deps.log.warn('attestation lookup failed: the withdrawal stays unsettled', {
        swapId: rec.swapId,
        requestId: id,
        error: e,
      });
      return recheck ? 'not-included' : 'uncertain';
    }
    if (att) {
      delete w.error;
      delete w.unresolved;
      delete w.uncertainSinceMs;
      delete w.recheckUntilMs;
      delete w.resolution;
      this.recheckReads.delete(id);
      w.attested = att.kind;
      if (att.kind === 'success') {
        pushStage(w, 'completed', now, { settledElsewhere: 'true' });
        this.makeCurrent(rec, w);
        if (!isTerminal(rec.state)) {
          rec.outcome = w.kind === 'swap' ? 'swapped' : 'bridged-back';
          transition(rec, 'done', now);
        }
      } else {
        // Refunded by whoever settled it: the coin is back in the temporary wallet.
        pushStage(w, 'refunded', now, { settledElsewhere: 'true' });
        if (running && current) transition(rec, this.backAfter(rec, w), now);
        this.newWithdrawAttempt(rec);
      }
      this.persist(rec);
      return 'settled';
    }
    if (recheck) return 'not-included'; // still absent: checked again later
    const lastStageMs = (w.stages.at(-1)?.at ?? 0) * 1000;
    const since = w.uncertainSinceMs ?? w.submittedAtMs ?? lastStageMs;
    // The latest moment it could be included: recorded before it was sent, else bounded by the time
    // its outcome became unknown plus one time to live.
    const expiry = w.expiresAtMs ?? lastStageMs + WITHDRAW_TX_TTL_MS;
    const fresh = reqs.asOf !== undefined && reqs.asOf.timeMs >= expiry + this.cfg.expiryMarginMs;
    if (nowMs - since < this.cfg.uncertainWindowMs) return 'uncertain';
    if (!fresh) {
      this.deps.log.warn('the vault read does not cover the withdrawal’s expiry yet: it stays uncertain', {
        swapId: rec.swapId,
        requestId: id,
        expiresAtMs: expiry,
        readAtBlockMs: reqs.asOf?.timeMs ?? null,
      });
      return 'uncertain';
    }
    this.withdrawFailed(
      rec,
      w,
      new DriveError('not-included', 'the withdrawal never reached the vault: nothing moved; build it again'),
      'not-included',
    );
    w.recheckUntilMs = nowMs + this.cfg.recheckMs;
    this.persist(rec);
    return 'not-included';
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
    if (w.startedAtMs === undefined && !w.startTx && !w.startTxId) {
      // Sent (or being sent) when the sponsor stopped, or uncertain: its request id settles it. A
      // lagging read is never taken as "it did not land" (audit R5).
      if (w.stage !== 'submission-uncertain') this.markUncertain(rec, w, 'the sponsor stopped while submitting');
      const outcome = await this.reconcileAttempt(rec, w, be);
      if (outcome !== 'adopted') return;
    }
    // Its start is on chain: its record holds the nonce (a reservation); no lane is needed.
    w.startedAtMs ??= this.now();
    try {
      this.stage(rec, w, 'resumed');
      await this.relayAndSettleWithdraw(swapId, be, true);
    } catch (e) {
      this.withdrawStalled(rec, w, e);
    }
  }

  private onRelayProgress(rec: SwapRecord, target: DepositRecord | WithdrawRecord, p: RelayProgress): void {
    const s = (ms: number) => String(Math.round(ms / 1000));
    switch (p.stage) {
      case 'signed':
        this.mpc.lastSignatureAfterMs = p.afterMs;
        target.signedAtMs ??= this.now();
        target.signedTxHash = p.signedTxHash;
        if ('kind' in target && p.maxFeePerGas !== undefined) {
          // The fee fields the MPC signed: a replacement must outbid them (audit R2).
          target.signedFees = {
            maxFeePerGas: p.maxFeePerGas.toString(),
            maxPriorityFeePerGas: (p.maxPriorityFeePerGas ?? 0n).toString(),
          };
        }
        this.stage(rec, target, 'mpc-signed', {
          signedTx: p.signedTxHash,
          evmNonce: String(p.nonce),
          afterS: s(p.afterMs),
          ...(p.maxFeePerGas !== undefined ? { maxFeePerGas: p.maxFeePerGas.toString() } : {}),
          ...(p.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: p.maxPriorityFeePerGas.toString() } : {}),
        });
        return;
      case 'pending':
        this.stage(rec, target, 'evm-pending', { signedTx: p.signedTxHash, evmNonce: String(p.nonce) });
        return;
      case 'broadcast':
        if ('kind' in target) target.sepoliaTx = p.evmTxHash;
        else target.sweepTx = p.evmTxHash;
        target.minedAtMs ??= this.now();
        this.stage(rec, target, 'evm-broadcast', {
          evmTx: p.evmTxHash,
          evmBlock: String(p.evmBlock),
          evmStatus: String(p.evmStatus ?? ''),
        });
        return;
      case 'not-broadcast':
        this.stage(rec, target, 'evm-not-broadcast', { reason: p.reason.slice(0, 200) });
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

  private async relayAndSettleWithdraw(swapId: string, be: SwapBackend, resumed: boolean): Promise<void> {
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
      onProgress: (p) => this.onRelayProgress(rec, w, p),
    });
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
      transition(rec, this.backAfter(rec, w), now);
      this.newWithdrawAttempt(rec); // the retry gets a fresh budget (audit C11)
      this.deps.log.info('withdrawal refunded', { swapId, requestId, attested: relay.kind });
    } else {
      pushStage(w, 'completed', now, { circuit, ...(settled.txHash ? { tx: settled.txHash } : {}) });
      const d = rec.deposit;
      if (w.kind === 'bridge-back' && d?.mintedTotal !== undefined) {
        // A Bridge back of a partial deposit (audit S2): what it returned is counted, and the swap
        // ends only when nothing is left to recover.
        d.returned = (BigInt(d.returned ?? '0') + BigInt(w.amount)).toString();
        if (await this.leftToRecover(rec, be)) {
          transition(rec, 'partial', now);
          pushStage(d, 'partial', now, { minted: heldOf(rec).toString(), remaining: remainingOf(rec).toString() });
          this.persist(rec);
          this.deps.log.info('partial deposit: part returned, the rest waits', { swapId });
          return;
        }
      }
      rec.outcome = w.kind === 'swap' ? 'swapped' : 'bridged-back';
      transition(rec, 'done', now);
      this.deps.log.info('swap done', { swapId, outcome: rec.outcome });
    }
    this.persist(rec);
  }

  /** After a Bridge back of a partial deposit: the wallet still holds some of the pay token, or the
   *  deposit address holds some of the remainder (read now; an unreadable address counts as holding). */
  private async leftToRecover(rec: SwapRecord, be: SwapBackend): Promise<boolean> {
    if (heldOf(rec) > 0n) return true;
    if (remainingOf(rec) === 0n) return false;
    const there = await be.evm.erc20Balance(rec.pay.erc20Address, rec.depositAddress).catch(() => null);
    if (there !== null) rec.deposit!.atAddress = there.toString();
    return there === null || there > 0n;
  }

  // ── Deposit ───────────────────────────────────────────────────────────────

  /** One pass over the swaps waiting for funds or `partial` (the timer calls it; tests call it
   *  directly). */
  pollDeposits(): Promise<void> {
    this.polling ??= this.pollOnce()
      .catch((e: unknown) => this.deps.log.warn('deposit poll failed', { error: e }))
      .finally(() => {
        this.polling = null;
      });
    return this.polling;
  }

  /** The swaps whose deposit address the poll reads: the whole deposit, or the remainder of a partial
   *  one while any is left to deposit (audit S2). */
  private static waitsForDeposit(r: SwapRecord): boolean {
    return r.state === 'awaiting_funds' || (r.state === 'partial' && remainingOf(r) > 0n);
  }

  /** Funded: the whole pay amount reached the address once, or part of it is in the wallet already. */
  private static funded(r: SwapRecord): boolean {
    return r.state === 'partial' || BigInt(r.deposit?.maxSeen ?? '0') >= BigInt(r.pay.amount);
  }

  /** Where a deposit that moved nothing leaves the swap: waiting for the whole amount, or `partial`
   *  when the wallet already holds part of it (audit S2). */
  private depositWaitState(rec: SwapRecord): 'awaiting_funds' | 'partial' {
    return mintedTotalOf(rec) > 0n ? 'partial' : 'awaiting_funds';
  }

  private async pollOnce(): Promise<void> {
    const be = this.deps.backend();
    const now = this.nowS();
    const nowMs = this.now();
    const b = this.cfg.pollBackoffMs;
    const due: SwapRecord[] = [];
    for (const rec of this.deps.store.all()) {
      if (!SwapService.waitsForDeposit(rec) || this.driving.has(rec.swapId)) {
        this.nextPoll.delete(rec.swapId);
        continue;
      }
      // Without a bridge the address cannot be read: never fail a swap on its age unread.
      if (!be) continue;
      if ((this.nextPoll.get(rec.swapId) ?? 0) > nowMs) continue;
      due.push(rec);
    }
    if (!be) return;
    // Every recipient's requests in the vault, whatever its address shows: a sweep between two
    // reads is reconciled all the same (audit S2).
    await this.reconcileRecipients(be, nowMs);
    // Funded swaps first, then the longest due, and at most `pollMaxReadsPerPass` Sepolia reads per
    // pass, whatever the number of swaps or of pages looking at them (audit R4, F-B26; S5: a flood of
    // unfunded swaps cannot delay a funded one).
    due.sort(
      (x, y) =>
        Number(SwapService.funded(y)) - Number(SwapService.funded(x)) ||
        (this.nextPoll.get(x.swapId) ?? 0) - (this.nextPoll.get(y.swapId) ?? 0),
    );
    let reads = 0;
    for (const rec of due) {
      if (reads >= this.cfg.pollMaxReadsPerPass) break;
      // The reconciliation may have moved it meanwhile.
      if (!SwapService.waitsForDeposit(rec) || this.driving.has(rec.swapId)) continue;
      const d = rec.deposit!;
      const amount = remainingOf(rec);
      // The token first; the sweep ETH only once the token is there (audit C6).
      let erc20: bigint;
      let eth = 0n;
      try {
        reads++;
        erc20 = await be.evm.erc20Balance(rec.pay.erc20Address, rec.depositAddress);
        if (erc20 >= amount) {
          reads++;
          eth = await be.evm.ethBalance(rec.depositAddress);
        }
      } catch (e) {
        this.deps.log.warn('deposit address read failed', { swapId: rec.swapId, error: e });
        continue;
      }
      this.lastPoll.set(rec.swapId, nowMs);
      const before = BigInt(d.maxSeen ?? '0');
      const previous = d.atAddress === undefined ? before : BigInt(d.atAddress);
      if (erc20 > before) d.maxSeen = erc20.toString();
      if (erc20 > 0n && d.seenAt === undefined) d.seenAt = now;
      if (d.atAddress !== erc20.toString()) {
        d.atAddress = erc20.toString();
        this.persist(rec);
      }
      const tokenThere = erc20 >= amount;
      // The balance first, the age second: a swap whose token reached the address is never failed for
      // its age, whatever kept the sponsor from starting it (audit C5). A swap that received nothing
      // gets the short window, one with part of the token the long one (audit C6). A `partial` swap
      // holds funds in the temporary wallet: never failed by age.
      const since = [...rec.history].reverse().find((h) => h.state === rec.state)?.at ?? rec.createdAt;
      if (rec.state === 'awaiting_funds') {
        const window = d.seenAt === undefined ? this.cfg.fundsWaitSeconds : this.cfg.fundsWaitPartialSeconds;
        if (!tokenThere && erc20 >= before && now - since > window) {
          transition(rec, 'failed', now, {
            reason: 'funds-not-received',
            message: 'the deposit address did not receive the funds in time; re-open the swap to keep waiting',
            recoverable: true,
          });
          this.nextPoll.delete(rec.swapId);
          this.persist(rec);
          continue;
        }
      }
      const age = now - since;
      // Fast while young or funded; an address holding less than the whole amount backs off like an
      // empty one (audit S5: one base unit does not buy the fast poll).
      this.nextPoll.set(
        rec.swapId,
        nowMs + (SwapService.funded(rec) || age < 600 ? b.fast : age < 3_600 ? b.medium : b.slow),
      );
      // The token LEFT the address since the last read: a request swept it into the vault for this
      // recipient (the sponsor's own after a crash, or anyone's); complete it (audit R6).
      if (erc20 < previous) {
        if (this.sweptCheckDue(rec.swapId, nowMs)) this.spawn(rec.swapId, () => this.completeSweptDeposits(rec.swapId));
        continue;
      }
      if (!tokenThere || eth < BigInt(rec.sweepGas.ethWei)) continue;
      const s = this.deps.sponsor();
      if (!s.synced || (s.dustSpecks !== null && s.dustSpecks < this.cfg.dustLowSpecks)) continue;
      // The remainder of a partial deposit: its starts are paced like re-arms (the first at once; audit S2).
      if (rec.state === 'partial') {
        const at = this.rearmAt(d);
        if (at > now) {
          if (d.stage !== 'rearm-wait') this.stage(rec, d, 'rearm-wait', { retryAt: String(at) });
          continue;
        }
      }
      // The swap's DUST is committed now that its funds are all there, not at open (audit R4): over
      // the daily budget it waits here, funded and never failed by age, until the budget allows it.
      if (this.overBudget(1)) {
        if (d.stage !== 'budget-wait') this.stage(rec, d, 'budget-wait');
        continue;
      }
      if (rec.state === 'partial') {
        d.rearmTimes = [...(d.rearmTimes ?? []).filter((t) => t > now - 86_400), now];
        SwapService.clearRequest(d);
      }
      this.stage(rec, rec.deposit!, 'funds-seen', {
        erc20: erc20.toString(),
        wei: eth.toString(),
        amount: amount.toString(),
      });
      transition(rec, 'depositing', this.nowS());
      this.persist(rec);
      this.spawn(rec.swapId, () => this.driveDeposit(rec.swapId));
    }
  }

  /** Forget a settled request before the next one of the same swap (a partial deposit's remainder). */
  private static clearRequest(d: DepositRecord): void {
    for (const k of [
      'requestId',
      'requestAmount',
      'startTx',
      'startTxId',
      'sweepTx',
      'completeTx',
      'completeTxId',
      'attested',
      'startedAtMs',
      'signedAtMs',
      'signedTxHash',
      'minedAtMs',
    ] as const) {
      delete d[k];
    }
  }

  /** At most one swept-deposit check per swap every 2 minutes (each reads the vault's requests). */
  private readonly sweptChecks = new Map<string, number>();
  private sweptCheckDue(swapId: string, nowMs: number): boolean {
    const last = this.sweptChecks.get(swapId);
    if (last !== undefined && nowMs - last < 120_000) return false;
    this.sweptChecks.set(swapId, nowMs);
    return true;
  }

  /** When the vault's deposit requests were last read for every waiting recipient (ms). */
  private lastReconcileMs = Number.NEGATIVE_INFINITY;
  /** Foreign requests attested as never having moved anything: never completed, never read again. */
  private readonly notSwept = new Set<string>();

  /**
   * Every `reconcileMs`: ONE read of the vault's open deposit requests, matched against every swap
   * waiting for funds or `partial` by its deposit path, whatever its deposit address showed (audit S2,
   * F-B33: funds swept between two reads left no trace in the balances). A request that is not the
   * swap's own current one and that the MPC attests as executed is completed in the background; one
   * not attested yet is left to the poll (the sponsor's own start after a crash is adopted there).
   */
  private async reconcileRecipients(be: SwapBackend, nowMs: number): Promise<void> {
    if (nowMs - this.lastReconcileMs < this.cfg.reconcileMs) return;
    const watched = this.deps.store.all().filter((r) => SwapService.waitsForDeposit(r) && !this.driving.has(r.swapId));
    if (watched.length === 0) return;
    this.lastReconcileMs = nowMs;
    let open: OpenRequests;
    try {
      open = await be.openRequests('deposit');
    } catch (e) {
      this.deps.log.warn('the vault’s deposit requests cannot be read', { error: e });
      return;
    }
    const byPath = new Map<string, SwapRecord>();
    for (const r of watched) byPath.set(be.depositPathHex(r.tempCoinPk), r);
    const hit = new Set<string>();
    for (const id of open.ids) {
      const path = open.pathOf(id);
      const r = path === undefined ? undefined : byPath.get(path);
      if (!r || hit.has(r.swapId) || id === r.deposit?.requestId || this.notSwept.has(id)) continue;
      if ((r.deposit?.foreign ?? []).some((f) => f.requestId === id)) continue;
      const att = await be.attestation('deposit', id).catch(() => null);
      if (!att) continue; // nothing moved yet
      if (att.kind !== 'success') {
        this.notSwept.add(id); // it never moved the tokens: nothing to complete
        continue;
      }
      hit.add(r.swapId);
    }
    for (const swapId of hit) this.spawn(swapId, () => this.completeSweptDeposits(swapId, open));
  }

  /**
   * Requests for this swap's recipient that are not its own swept tokens into the vault (anyone may
   * start one: `startDeposit` and `completeDeposit` are permissionless). The sponsor completes EVERY
   * such request the MPC attests as executed ("it actually swept"), whoever started it (audit R6):
   *  - one that moved exactly what this swap still needs of its pay token IS its deposit (adopted);
   *  - any other still mints to the temporary wallet, and when it moved the pay token it is counted
   *    (`mintedTotal`): less than the pay amount in all → `partial` (audit S2), the whole → `minted`.
   * Each completion is a settle the sponsor pays: reserved from the daily budget BEFORE it is queued,
   * and recorded as spent once it ran (audit S6).
   */
  private async completeSweptDeposits(swapId: string, pre?: OpenRequests): Promise<void> {
    const be = this.deps.backend();
    const rec = this.get(swapId);
    const d = rec.deposit!;
    if (!be || !SwapService.waitsForDeposit(rec)) return;
    const open = pre ?? (await be.openRequests('deposit'));
    const path = be.depositPathHex(rec.tempCoinPk);
    for (const id of open.ids.filter((x) => open.pathOf(x) === path && x !== d.requestId)) {
      if ((d.foreign ?? []).some((f) => f.requestId === id) || this.notSwept.has(id)) continue;
      const att = await be.attestation('deposit', id).catch(() => null);
      if (!att) continue; // not attested (yet): nothing moved so far
      if (att.kind !== 'success') {
        this.notSwept.add(id); // it never moved the tokens: nothing to complete
        continue;
      }
      const s = this.deps.sponsor();
      if (!s.synced || (s.dustSpecks !== null && s.dustSpecks < this.cfg.dustLowSpecks)) return;
      if (!SwapService.waitsForDeposit(rec)) return;
      const dt = open.detailOf(id);
      const now = this.nowS();
      const payToken = dt !== undefined && dt.erc20.toLowerCase() === rec.pay.erc20Address.toLowerCase();
      if (payToken && dt.amount === remainingOf(rec)) {
        if (this.overBudget(1)) {
          if (d.stage !== 'budget-wait') this.stage(rec, d, 'budget-wait');
          return;
        }
        SwapService.clearRequest(d);
        transition(rec, 'depositing', now);
        d.requestId = id;
        d.requestAmount = dt.amount.toString();
        d.attested = 'success';
        pushStage(d, 'adopted', now, { requestId: id, sweptBy: 'another-request' });
        this.persist(rec);
        await this.settleDeposit(rec, be, att);
        return;
      }
      const release = this.reserveDust(this.cfg.dustPerSettleSpecks);
      if (!release) {
        if (d.stage !== 'budget-wait') this.stage(rec, d, 'budget-wait');
        return;
      }
      try {
        const out = await this.withProver(() =>
          be.settle({
            circuit: 'completeDeposit',
            requestId: id,
            attestation: att,
            recipientCoinPk: rec.tempCoinPk,
            recipientEncPk: rec.tempEncPk,
          }),
        );
        (d.foreign ??= []).push({
          requestId: id,
          erc20: dt?.erc20 ?? '',
          amount: (dt?.amount ?? 0n).toString(),
          at: now,
          ...(out.txHash ? { completeTx: out.txHash } : {}),
        });
        pushStage(d, 'completed-foreign', this.nowS(), {
          requestId: id,
          ...(dt ? { erc20: dt.erc20, amount: dt.amount.toString() } : {}),
        });
        if (payToken && out.minted && dt.amount > 0n) {
          // The temporary wallet received this much of the pay token (audit S2).
          d.mintedTotal = (mintedTotalOf(rec) + dt.amount).toString();
          const target = holdingState(rec);
          if (rec.state !== target) transition(rec, target, this.nowS());
          if (target === 'partial') {
            d.attempts = 0; // the remainder's own attempts
            pushStage(d, 'partial', this.nowS(), {
              requestId: id,
              minted: heldOf(rec).toString(),
              remaining: remainingOf(rec).toString(),
            });
          }
          this.deps.log.warn('a foreign deposit request for this recipient was completed', {
            swapId,
            requestId: id,
            amount: dt.amount.toString(),
            state: rec.state,
          });
        }
        this.persist(rec);
      } finally {
        release(); // recorded as spent by its stage now
      }
      if (!SwapService.waitsForDeposit(rec)) return;
    }
  }

  /** Start (or resume) a swap's deposit (the whole amount, or a partial deposit's remainder) and
   *  drive it to `minted`. */
  async driveDeposit(swapId: string): Promise<void> {
    const rec = this.get(swapId);
    const d = rec.deposit!;
    const be = this.deps.backend();
    if (!be || rec.state !== 'depositing') return;
    let gas: EvmGasPolicy = {
      gasLimit: BigInt(rec.sweepGas.gasLimit),
      maxFeePerGas: BigInt(rec.sweepGas.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(rec.sweepGas.maxPriorityFeePerGas),
      keyVersion: 1n,
    };
    let resumed = d.requestId !== undefined;
    if (!d.requestId) {
      const amount = remainingOf(rec);
      try {
        const path = be.depositPathHex(rec.tempCoinPk);
        const [open, erc20, eth, nextNonce, evmNonce, baseFee] = await Promise.all([
          be.openRequests('deposit'),
          be.evm.erc20Balance(rec.pay.erc20Address, rec.depositAddress),
          be.evm.ethBalance(rec.depositAddress),
          be.evm.nonce(rec.depositAddress, 'latest'),
          be.evm.nonce(rec.depositAddress, 'pending'),
          be.evm.baseFeePerGas(),
        ]);
        // An earlier start of this swap may be open already (a crash after it landed): adopt it, but
        // only a request with the sponsor's OWN parameters: this swap's token and the amount it still
        // needs, the deposit address's next nonce, this swap's sweep gas limit, and BOTH fee fields
        // within the live sweep policy (a tip of at least the policy's, a fee cap of at least 1.25 ×
        // the live base fee + tip) at a cost the ETH at the address pays. `startDeposit` is
        // permissionless, so anyone can open a request for this recipient; one with a nonce gap or a
        // fee that can never be mined would leave the deposit waiting forever (audit C12, R6, S3).
        const gasLimit = BigInt(rec.sweepGas.gasLimit);
        const tipPolicy = BigInt(rec.sweepGas.maxPriorityFeePerGas);
        const feeFloor = ceilTenthGwei((5n * baseFee) / 4n + tipPolicy);
        const own = (id: string) => {
          const dt = open.detailOf(id);
          return (
            dt !== undefined &&
            dt.erc20.toLowerCase() === rec.pay.erc20Address.toLowerCase() &&
            dt.amount === amount &&
            dt.evmNonce === nextNonce &&
            dt.gasLimit === gasLimit &&
            dt.maxPriorityFeePerGas !== undefined &&
            dt.maxPriorityFeePerGas >= tipPolicy &&
            dt.maxPriorityFeePerGas <= dt.maxFeePerGas &&
            dt.maxFeePerGas >= feeFloor &&
            dt.gasLimit * dt.maxFeePerGas <= eth &&
            dt.gasLimit * dt.maxFeePerGas <= this.cfg.maxSweepWei
          );
        };
        const done = new Set((d.foreign ?? []).map((f) => f.requestId));
        const forPath = open.ids.filter((id) => open.pathOf(id) === path && !done.has(id) && !this.notSwept.has(id));
        const mine = forPath.filter(own);
        const others = forPath.filter((id) => !own(id));
        if (others.length > 0) {
          this.deps.log.warn('open deposit requests for this recipient that are not this swap’s', {
            swapId,
            requests: others,
          });
        }
        if (mine.length > 0) {
          d.requestId = mine[0]!;
          d.requestAmount = amount.toString();
          resumed = true;
          this.stage(rec, d, 'adopted', { requestId: d.requestId });
        } else {
          if (d.attempts >= this.cfg.maxDepositAttempts) {
            transition(rec, 'failed', this.nowS(), {
              reason: 'deposit-attempts',
              message: `the deposit was tried ${d.attempts} times without success; the funds wait at the deposit address (re-open the swap to try again)`,
              // The funds wait at the address: always recoverable, paced by the re-arm cooldown (audit R3).
              recoverable: true,
            });
            this.persist(rec);
            return;
          }
          // The sweep's fee is fixed now, from the live base fee and the ETH actually at the address:
          // the largest cap that ETH covers (audit C2). It must also outbid, on both fee fields, every
          // other request that could be a valid transaction for the same deposit-address nonce (its
          // fields consistent and its cost covered by the ETH at the address: a pool admits nothing
          // else), since a pool refuses a replacement that does not (audit S3, the R2 rule). Too
          // little ETH for that: ask for more (the swap's sweepGas rises) and wait.
          const competing = others
            .map((id) => open.detailOf(id))
            .filter(
              (dt): dt is NonNullable<typeof dt> =>
                dt !== undefined &&
                dt.evmNonce === nextNonce &&
                (dt.maxPriorityFeePerGas ?? 0n) <= dt.maxFeePerGas &&
                dt.gasLimit * dt.maxFeePerGas <= eth,
            );
          const sized = this.sweepAtStart(rec, eth, baseFee, competing);
          if (!sized.gas) {
            this.raiseSweepGas(rec, baseFee, sized.needFee);
            throw new DriveError(
              'sweep-gas-low',
              `Sepolia's base fee rose: the deposit address needs ${rec.sweepGas.ethWei} wei for the sweep`,
            );
          }
          gas = sized.gas;
          const pre = depositPreflight({
            erc20Balance: erc20,
            amount,
            ethBalance: eth,
            gasLimit: gas.gasLimit,
            maxFeePerGas: gas.maxFeePerGas,
            decimals: rec.pay.decimals,
          });
          if (!pre.ok) throw new DriveError(BRIDGE_ERRORS.preflight, pre.problems.join('; '));
          d.attempts++;
          this.stage(rec, d, 'starting', {
            evmNonce: evmNonce.toString(),
            maxFeePerGas: gas.maxFeePerGas.toString(),
            amount: amount.toString(),
          });
          const out = await this.withProver(() =>
            be.startDeposit({
              recipientCoinPk: rec.tempCoinPk,
              erc20: rec.pay.erc20Address,
              amount,
              gas,
              evmNonce,
            }),
          );
          d.requestId = out.requestId;
          d.requestAmount = amount.toString();
          d.startedAtMs = this.now();
          if (out.txHash) d.startTx = out.txHash;
          if (out.txId) d.startTxId = out.txId;
          this.stage(rec, d, 'started', { requestId: out.requestId, ...(out.txHash ? { tx: out.txHash } : {}) });
        }
      } catch (e) {
        const code = e instanceof DriveError ? e.code : 'deposit-start-failed';
        this.deps.log.warn('deposit start failed', { swapId, error: e });
        const back = this.depositWaitState(rec);
        pushStage(d, back === 'partial' ? 'partial' : 'waiting-for-funds', this.nowS(), { error: code });
        transition(rec, back, this.nowS());
        this.persist(rec);
        return;
      }
    }
    await this.relayAndSettleDeposit(rec, be, resumed);
  }

  /**
   * The sweep's gas at start: the largest 0.1-gwei cap the ETH at the address covers (within
   * SWEEP_MAX_WEI), which must reach 1.25 × the live base fee + tip AND outbid every competing request
   * of the same nonce on both fee fields (audit S3). `gas` is null when the ETH does not cover
   * `needFee`.
   */
  private sweepAtStart(
    rec: SwapRecord,
    eth: bigint,
    baseFee: bigint,
    competing: readonly { maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint }[] = [],
  ): { gas: EvmGasPolicy | null; needFee: bigint } {
    const gasLimit = BigInt(rec.sweepGas.gasLimit);
    let tip = BigInt(rec.sweepGas.maxPriorityFeePerGas);
    let outbid = 0n;
    for (const c of competing) {
      const t = this.bumped(c.maxPriorityFeePerGas ?? 0n);
      if (t > tip) tip = t;
      const f = this.bumped(c.maxFeePerGas);
      if (f > outbid) outbid = f;
    }
    const live = ceilTenthGwei((5n * baseFee) / 4n + tip);
    const needFee = live > outbid ? live : outbid;
    const byEth = floorTenthGwei(eth / gasLimit);
    const byPolicy = floorTenthGwei(this.cfg.maxSweepWei / gasLimit);
    const maxFeePerGas = byEth < byPolicy ? byEth : byPolicy;
    if (maxFeePerGas < needFee) return { gas: null, needFee };
    return { gas: { gasLimit, maxFeePerGas, maxPriorityFeePerGas: tip, keyVersion: 1n }, needFee };
  }

  /** Raise (never lower) the swap's sweep gas to the G-BRIDGE sizing at `baseFee` (2 × base + tip), or
   *  to `minFee` when a competing request must be outbid (audit S3). */
  private raiseSweepGas(rec: SwapRecord, baseFee: bigint, minFee = 0n): boolean {
    const gasLimit = BigInt(rec.sweepGas.gasLimit);
    const tip = BigInt(rec.sweepGas.maxPriorityFeePerGas);
    const sized = ceilTenthGwei(2n * baseFee + tip);
    const maxFeePerGas = sized > minFee ? sized : minFee;
    const ethWei = gasLimit * maxFeePerGas;
    if (ethWei <= BigInt(rec.sweepGas.ethWei)) return false;
    if (ethWei > this.cfg.maxSweepWei) {
      this.deps.log.warn('the sweep would cost more than SWEEP_MAX_WEI: it waits for the fee to fall', {
        swapId: rec.swapId,
        ethWei: ethWei.toString(),
      });
      return false;
    }
    rec.sweepGas = { ...rec.sweepGas, maxFeePerGas: maxFeePerGas.toString(), ethWei: ethWei.toString() };
    this.persist(rec);
    return true;
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
      delete d.requestAmount;
      delete d.startedAtMs;
      const back = this.depositWaitState(rec);
      transition(rec, back, this.nowS());
      pushStage(d, back === 'partial' ? 'partial' : 'waiting-for-funds', this.nowS(), {
        retry: String(d.attempts + 1),
      });
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
      // What it minted counts toward the pay amount: the whole amount (or the rest of a partial
      // deposit) → `minted`; less → `partial` (audit S2).
      d.mintedTotal = (mintedTotalOf(rec) + BigInt(d.requestAmount ?? rec.pay.amount)).toString();
      const target = holdingState(rec);
      transition(rec, target, now);
      if (target === 'partial') {
        pushStage(d, 'partial', now, {
          requestId,
          minted: heldOf(rec).toString(),
          remaining: remainingOf(rec).toString(),
        });
      }
      this.deps.log.info('deposit minted', { swapId: rec.swapId, requestId, state: target });
    } else {
      pushStage(d, 'closed', now, { attested: att.kind });
      transition(rec, 'failed', now, {
        reason: 'deposit-returned-false',
        message: 'the token refused the vault’s transfer: nothing was minted (the funds stay at the deposit address)',
        recoverable: true,
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
   * Every withdrawal attempt whose outcome is unknown (audit R5, F-B28), superseded ones included
   * (not only the latest, and with no time limit), and every attempt judged not included in the last
   * `recheckMs` (audit S1): each is settled by its request id. One that landed after all is adopted
   * and driven to its settle, which the sponsor pays: at most `limit` of those per call (the stale
   * closer's cap). Returns the adopted swaps.
   */
  async adoptLateStarts(_sinceS?: number, limit = Number.POSITIVE_INFINITY): Promise<string[]> {
    const be = this.deps.backend();
    if (!be) return [];
    const nowMs = this.now();
    const pending = (w: WithdrawRecord) => isUnresolved(w) || isRecheck(w, nowMs);
    const candidates = this.deps.store.all().filter((r) => !this.driving.has(r.swapId) && r.withdrawals.some(pending));
    if (candidates.length === 0) return [];
    const open = await be.openRequests('withdraw');
    const adopted: string[] = [];
    for (const rec of candidates) {
      for (const w of rec.withdrawals.filter(pending)) {
        if (open.ids.includes(w.requestId!) && adopted.length >= limit) continue;
        const outcome = await this.reconcileAttempt(rec, w, be, open);
        if (outcome === 'adopted') {
          this.spawn(rec.swapId, () => this.resumeWithdraw(rec.swapId));
          adopted.push(rec.swapId);
          break;
        }
      }
    }
    return adopted;
  }
}

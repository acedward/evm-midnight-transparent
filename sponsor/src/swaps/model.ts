// A swap as the sponsor keeps it: public values only (no seed, no secret key, no bearer token:
// only the token's SHA-256), the state machine, and the view the swap routes answer with.
//
// The states (core swap-api.ts):
//
//   awaiting_funds ─► depositing ─► minted ─► taking ─► taken ─► withdrawing ─► done (swapped)
//                         │            │  ▲                          │
//                         │            │  └── refund (the vault's transfer did not happen) ◄─┤
//                         │            └──────────────────────────► bridging_back ─► done (bridged back)
//                         └─ never-executed sweep: back to awaiting_funds (the funds wait at the address)
//   any non-terminal state ─► failed (with a reason); a RECOVERABLE failure ─► awaiting_funds on re-open
//   (funds-not-received; deposit-attempts and deposit-returned-false while re-arms remain: the
//   funds wait at the deposit address and a new startDeposit to the same recipient moves them)
//   taken ─► minted on a not-available report, and ─► bridging_back: a "taken" report never blocks
//   Bridge back, because only the coin the temporary wallet really holds can be withdrawn (audit C13)
//   awaiting_funds ─► partial: a completed deposit request minted LESS of the pay token than the swap
//   pays (anyone may start one for this recipient; audit S2). partial ─► depositing (the remainder, once
//   it is at the address) ─► minted; partial ─► bridging_back (what arrived goes back) ─► done, or back
//   to partial while the address still holds some of the pay token.
//
// `minted` means "the temporary wallet holds the funds and the app acts next": after the deposit,
// after a lost take race ("Swap is not available"), and after a refunded withdrawal.

import {
  SWAP_ERRORS,
  type PartialDeposit,
  type PartialOption,
  type StageEntry,
  type SwapState,
  type SwapView,
  type SweepGas,
  type WithdrawKind,
  type WithdrawalStatus,
} from '@evm-midnight-transparent/core';

export type AttestedKind = 'success' | 'returned-false' | 'never-executed';

export interface LegRecord {
  colour: string;
  amount: string;
  symbol: string;
  erc20Address: string;
  decimals: number;
}

/** The EIP-1559 fee fields a request signs (decimal strings). */
export interface GasRecord {
  gasLimit: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
}

/** The relay's progress on the signed Sepolia transfer (both legs; audit C2, C3). */
interface TransferProgress {
  /** ms: when the MPC's signature was first seen. */
  signedAtMs?: number;
  signedTxHash?: string;
  /** ms: when the transfer's receipt was first seen. */
  minedAtMs?: number;
}

export interface DepositRecord extends TransferProgress {
  stage: string;
  stages: StageEntry[];
  attempts: number;
  requestId?: string;
  startTx?: string;
  startTxId?: string;
  sweepTx?: string;
  completeTx?: string;
  completeTxId?: string;
  attested?: AttestedKind;
  /** ms: when the start landed (the MPC signature budget counts from it). */
  startedAtMs?: number;
  /** How many times a re-open re-armed this deposit after a recoverable failure (audit C5). */
  rearms?: number;
  /** Unix seconds: when the deposit address was first seen holding any of the token (audit C6). */
  seenAt?: number;
  /** The most of the token the deposit address was seen holding (base units): less later means a
   *  request swept it into the vault for this recipient (audit R6). */
  maxSeen?: string;
  /** Unix seconds of each re-arm: paced by a cooldown and a per-day count, never a lifetime cap (audit R3). */
  rearmTimes?: number[];
  /** Requests of another party that swept this recipient's deposit address with another token or
   *  amount, completed by the sponsor so the coin reaches the temporary wallet (audit R6). */
  foreign?: { requestId: string; erc20: string; amount: string; at: number; completeTx?: string }[];
  /** Base units of the PAY token every completed deposit request of this recipient minted into the
   *  temporary wallet (the sponsor's own and anyone else's; audit S2). Absent on records completed
   *  before P4.2-fix3: their one own deposit minted the pay amount. */
  mintedTotal?: string;
  /** Base units of the pay token a Bridge back from `partial` returned (audit S2). */
  returned?: string;
  /** The amount of the request `requestId` moves (the remainder, in `partial`). */
  requestAmount?: string;
  /** The pay token the sponsor last read at the deposit address (base units). */
  atAddress?: string;
}

export interface WithdrawRecord extends TransferProgress {
  kind: WithdrawKind;
  colour: string;
  amount: string;
  stage: string;
  stages: StageEntry[];
  refunds: number;
  /** The EVM nonce the call signs. */
  evmNonce: string;
  /** The nonce of the coin the call hands to the vault (public: a call argument). */
  coinNonce: string;
  /** The transfer's fee fields, sized from the live base fee at withdraw-params (audit C2). */
  gas?: GasRecord;
  /** The request the call creates (predicted from the call's own next state, before it is sent). */
  requestId?: string;
  startTx?: string;
  startTxId?: string;
  sepoliaTx?: string;
  completeTx?: string;
  completeTxId?: string;
  attested?: AttestedKind;
  startedAtMs?: number;
  error?: { code: string; message: string };
  /** ms: when the transaction was handed to the node (the start's request id is known from then). */
  submittedAtMs?: number;
  /** ms: since when the submission's outcome is unknown (stage `submission-uncertain`, audit R5). */
  uncertainSinceMs?: number;
  /** A failed attempt recorded before P4.2-fix2 that named a request id: whether it landed is not
   *  established, so it keeps its nonce until the sponsor reconciles it (audit R5). */
  unresolved?: boolean;
  /** How an attempt that failed ended, when it is settled: `not-submitted` (never reached the node),
   *  `failed-on-chain`, `not-included` (established by reconciliation). */
  resolution?: 'not-submitted' | 'failed-on-chain' | 'not-included';
  /** The fee fields of the transfer the MPC actually signed (audit R2: replacements outbid both). */
  signedFees?: { maxFeePerGas: string; maxPriorityFeePerGas: string };
  /** ms: the latest moment the submitted transaction could still be included (its DUST intent's time
   *  to live, or an upper bound of it). "Not included" is concluded only from a vault read at an
   *  indexer block past it plus a margin (audit S1). */
  expiresAtMs?: number;
  /** ms: an attempt judged `not-included` is re-checked by its request id until then, and adopted if
   *  it landed after all (audit S1). */
  recheckUntilMs?: number;
}

/** What the latest `withdraw-params` handed out: `/prove withdraw` rebuilds with its gas, and tells a
 *  vault that moved since (409, rebuild) from a wrong call (422) by its state mark (audit C11). */
export interface WithdrawOffer {
  kind: WithdrawKind;
  evmNonce: string;
  /** A digest of the vault's contract state when the parameters were handed out. */
  vaultMark?: string;
  /** The fee fields handed out (sized from the live base fee; audit C2). */
  gas?: GasRecord;
  at: number;
}

/** The version of the approval `/prove withdraw` records. `/withdraw` accepts only this one: an
 *  approval an older sponsor made was validated by older rules (audit S8), so it is proven again. */
export const PROVEN_WITHDRAW_VERSION = 3;

/** What the latest `/prove withdraw` validated: `/withdraw` must carry the same calls. */
export interface ProvenWithdraw {
  /** PROVEN_WITHDRAW_VERSION when it was approved (absent before P4.2-fix3). */
  v?: number;
  kind: WithdrawKind;
  /** The amount the approved withdrawal moves (a Bridge back from `partial` moves what arrived). */
  amount?: string;
  callsDigest: string;
  /** The proven transaction's structure (calls, segments, every shielded coin): `/withdraw` must
   *  carry exactly this one, apart from proofs and binding (audit C4). */
  structureDigest?: string;
  coinNonce: string;
  evmNonce: string;
  gas?: GasRecord;
  at: number;
  /** The whole proof-erased transaction `/prove` validated (hex): `/withdraw` must erase to exactly
   *  it (audit R1). */
  erased?: string;
  /** The proof-budget entry this proof took (given back on a transient `/withdraw` refusal, audit R3). */
  proofId?: number;
}

/** One proof the swap asked for, in the rolling 24-hour budget (audit R3). */
export interface ProofEntry {
  id: number;
  at: number;
  purpose: 'take' | 'withdraw';
  /** Sent to the proof server and it failed: counts in the daily total, not in the purpose's budget. */
  failed?: boolean;
}

export interface SwapRecord {
  v: 1;
  swapId: string;
  /** Checksummed. */
  evmAddress: string;
  offerId: string;
  pay: LegRecord;
  receive: LegRecord;
  tempCoinPk: string;
  tempEncPk: string;
  depositAddress: string;
  sweepGas: SweepGas;
  /** SHA-256 (hex) of the current bearer token; the token itself is never stored. */
  tokenHash: string;
  state: SwapState;
  deposit: DepositRecord | null;
  takeTx: string | null;
  /** Proofs used: take and withdraw (the withdraw budget renews per attempt) and all of them; `log`
   *  holds the last 24 hours' proofs, which every budget counts (audit R3: no lifetime cap), and
   *  `withdrawSince` when the current withdrawal attempt began (unix seconds). */
  proofs: { take: number; withdraw: number; total?: number; log?: ProofEntry[]; withdrawSince?: number };
  withdrawOffer?: WithdrawOffer;
  provenWithdraw: ProvenWithdraw | null;
  withdrawals: WithdrawRecord[];
  outcome?: 'swapped' | 'bridged-back';
  reason?: string;
  message?: string;
  /** On `failed`: whether the same open-swap revives it (audit C5). */
  recoverable?: boolean;
  /** On a recoverable `failed` swap whose re-arm is paced: unix seconds from which a re-open revives it. */
  retryAt?: number;
  history: { state: SwapState; at: number }[];
  createdAt: number;
  updatedAt: number;
}

/** Which state may follow which. Anything else is a bug (or a replayed request) and throws. */
export const TRANSITIONS: Readonly<Record<SwapState, readonly SwapState[]>> = {
  awaiting_funds: ['depositing', 'partial', 'minted', 'failed'],
  depositing: ['minted', 'partial', 'awaiting_funds', 'failed'],
  partial: ['depositing', 'minted', 'bridging_back'],
  minted: ['taking', 'taken', 'withdrawing', 'bridging_back', 'failed'],
  taking: ['taken', 'minted', 'withdrawing', 'bridging_back', 'failed'],
  taken: ['withdrawing', 'bridging_back', 'minted', 'failed'],
  withdrawing: ['done', 'minted', 'failed'],
  bridging_back: ['done', 'minted', 'partial', 'failed'],
  done: [],
  failed: ['awaiting_funds', 'partial'],
};

export class TransitionError extends Error {
  override name = 'TransitionError';
  constructor(
    readonly from: SwapState,
    readonly to: SwapState,
  ) {
    super(`a swap cannot go from ${from} to ${to}`);
  }
}

export function canTransition(from: SwapState, to: SwapState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Move `rec` to `to` (in place), recording it. Throws TransitionError for an illegal move. */
export function transition(
  rec: SwapRecord,
  to: SwapState,
  now: number,
  extra: { reason?: string; message?: string; recoverable?: boolean } = {},
) {
  if (!canTransition(rec.state, to)) throw new TransitionError(rec.state, to);
  rec.state = to;
  rec.history.push({ state: to, at: now });
  if (rec.history.length > 100) rec.history.splice(0, rec.history.length - 100);
  rec.updatedAt = now;
  if (to === 'failed') {
    rec.reason = extra.reason ?? 'failed';
    rec.message = extra.message ?? 'the swap failed';
    rec.recoverable = extra.recoverable ?? false;
  } else {
    delete rec.reason;
    delete rec.message;
    delete rec.recoverable;
  }
  delete rec.retryAt;
}

/** The failures a re-open can revive (the funds wait at the deposit address, or never came). Every
 *  one stays recoverable while any balance or unsettled request remains (audit R3): no lifetime cap. */
export const RECOVERABLE_FAILURES: readonly string[] = [
  'funds-not-received',
  'deposit-attempts',
  'deposit-returned-false',
];

/** Whether a withdrawal attempt's outcome is still unknown (audit R5): its submission was uncertain,
 *  or it failed before P4.2-fix2 after naming a request id. It keeps its nonce until reconciled. */
export const isUnresolved = (w: WithdrawRecord): boolean =>
  w.requestId !== undefined && (w.stage === 'submission-uncertain' || w.unresolved === true);

export const isTerminal = (s: SwapState) => s === 'done' || s === 'failed';

/** The states in which the temporary wallet may hold a coin the app can move (in `partial`, only a
 *  Bridge back of what arrived). */
export const WALLET_HOLDS_FUNDS: readonly SwapState[] = ['minted', 'taking', 'taken', 'partial'];

/** Whether an attempt judged `not-included` is still re-checked by its request id (audit S1). It does
 *  NOT hold its nonce (the next withdrawal may take it: if it landed after all, the replacement rule
 *  settles the pair) and does not block a retry. */
export const isRecheck = (w: WithdrawRecord, nowMs: number): boolean =>
  w.requestId !== undefined &&
  w.stage === 'failed' &&
  w.resolution === 'not-included' &&
  (w.recheckUntilMs ?? 0) > nowMs;

// ── The pay token the temporary wallet received (audit S2) ─────────────────────

const big = (x: string | undefined) => BigInt(x ?? '0');

/** Base units of the pay token completed deposits minted into the temporary wallet. A record completed
 *  before P4.2-fix3 in a state past the deposit minted the pay amount. */
export function mintedTotalOf(rec: SwapRecord): bigint {
  const d = rec.deposit;
  if (d?.mintedTotal !== undefined) return BigInt(d.mintedTotal);
  // Every failure reason happens before anything is minted.
  return ['awaiting_funds', 'depositing', 'failed'].includes(rec.state) ? 0n : BigInt(rec.pay.amount);
}

/** What the temporary wallet holds of the pay token by the sponsor's accounting (minted − returned). */
export const heldOf = (rec: SwapRecord): bigint => mintedTotalOf(rec) - big(rec.deposit?.returned);

/** What is still to be deposited for the wallet to hold the whole pay amount (never negative). */
export function remainingOf(rec: SwapRecord): bigint {
  const r = BigInt(rec.pay.amount) - mintedTotalOf(rec);
  return r > 0n ? r : 0n;
}

/** The state a swap holding pay tokens rests in: `minted` with the whole pay amount, else `partial`. */
export const holdingState = (rec: SwapRecord): 'minted' | 'partial' =>
  heldOf(rec) >= BigInt(rec.pay.amount) ? 'minted' : 'partial';

/** The `partial` view (audit S2). */
export function partialView(rec: SwapRecord): PartialDeposit {
  const held = heldOf(rec);
  const remaining = remainingOf(rec);
  const options: PartialOption[] = [];
  if (remaining > 0n) options.push('wait');
  if (held > 0n) options.push('bridge-back');
  return {
    minted: (held > 0n ? held : 0n).toString(),
    remaining: remaining.toString(),
    atAddress: big(rec.deposit?.atAddress).toString(),
    options,
  };
}

/**
 * Whether the generic retention may drop this record (audit S4): only a finished record with nothing
 * left to recover. Never one that is recoverable, funded (its state holds funds, or it still holds
 * pay tokens by the sponsor's accounting, or the deposit address was last seen holding some), or that
 * has a withdrawal attempt whose outcome is unknown or still re-checked, or a deposit request that
 * did not settle.
 */
export function retentionMayDrop(r: SwapRecord, nowMs: number): boolean {
  // Only `done` (its withdrawal settled; a Bridge back from partial ends there only with nothing left)
  // and a failure no re-open can revive.
  if (r.state !== 'done' && !(r.state === 'failed' && r.recoverable !== true)) return false;
  if (r.withdrawals.some((w) => isUnresolved(w) || isRecheck(w, nowMs))) return false;
  const d = r.deposit;
  if (r.state === 'failed' && d) {
    if (d.requestId && !['completed', 'closed', 'abandoned'].includes(d.stage)) return false;
    if (big(d.atAddress) > 0n || big(d.maxSeen) > 0n || heldOf(r) > 0n) return false;
  }
  return true;
}

export function pushStage(
  rec: { stage: string; stages: StageEntry[] },
  stage: string,
  at: number,
  detail?: Record<string, string>,
) {
  rec.stage = stage;
  rec.stages.push(detail && Object.keys(detail).length > 0 ? { stage, at, detail } : { stage, at });
  if (rec.stages.length > 60) rec.stages.splice(0, rec.stages.length - 60);
}

export const currentWithdrawal = (rec: SwapRecord): WithdrawRecord | null => rec.withdrawals.at(-1) ?? null;

const copyStages = (s: StageEntry[]) => s.map((x) => ({ ...x, ...(x.detail ? { detail: { ...x.detail } } : {}) }));

/**
 * The retry signal (audit C1): the latest withdrawal ended without moving the funds and the
 * temporary wallet holds them again, so the page must rebuild the withdrawal and submit it again.
 */
export function withdrawalStatus(rec: SwapRecord): WithdrawalStatus {
  const w = currentWithdrawal(rec);
  let last: WithdrawalStatus['last'] = null;
  if (w?.stage === 'refunded') last = 'refunded';
  else if (w?.stage === 'failed') last = w.error?.code === SWAP_ERRORS.staleVaultState ? 'stale-vault' : 'start-failed';
  return { attempts: rec.withdrawals.length, last, retry: last !== null && WALLET_HOLDS_FUNDS.includes(rec.state) };
}

/** `refunds` = the withdrawals of this swap refunded so far, the given one included. */
function withdrawView(w: WithdrawRecord, refunds: number) {
  return {
    kind: w.kind,
    colour: w.colour,
    amount: w.amount,
    stage: w.stage,
    stages: copyStages(w.stages),
    refunds,
    ...(w.requestId ? { requestId: w.requestId } : {}),
    ...(w.startTx ? { startTx: w.startTx } : {}),
    ...(w.startTxId ? { startTxId: w.startTxId } : {}),
    ...(w.sepoliaTx ? { sepoliaTx: w.sepoliaTx } : {}),
    ...(w.completeTx ? { completeTx: w.completeTx } : {}),
    ...(w.completeTxId ? { completeTxId: w.completeTxId } : {}),
    ...(w.attested ? { attested: w.attested } : {}),
    ...(w.error ? { error: { ...w.error } } : {}),
  };
}

export function swapView(rec: SwapRecord): SwapView {
  const d = rec.deposit;
  let refunded = 0;
  const withdrawals = rec.withdrawals.map((x) => withdrawView(x, x.stage === 'refunded' ? ++refunded : refunded));
  return {
    swapId: rec.swapId,
    state: rec.state,
    evmAddress: rec.evmAddress,
    offerId: rec.offerId,
    pay: { ...rec.pay },
    receive: { ...rec.receive },
    tempCoinPk: rec.tempCoinPk,
    depositAddress: rec.depositAddress,
    erc20Address: rec.pay.erc20Address,
    amount: rec.pay.amount,
    sweepGas: { ...rec.sweepGas },
    deposit: d
      ? {
          stage: d.stage,
          stages: copyStages(d.stages),
          attempts: d.attempts,
          ...(d.requestId ? { requestId: d.requestId } : {}),
          ...(d.startTx ? { startTx: d.startTx } : {}),
          ...(d.startTxId ? { startTxId: d.startTxId } : {}),
          ...(d.sweepTx ? { sweepTx: d.sweepTx } : {}),
          ...(d.completeTx ? { completeTx: d.completeTx } : {}),
          ...(d.completeTxId ? { completeTxId: d.completeTxId } : {}),
          ...(d.attested ? { attested: d.attested } : {}),
        }
      : null,
    takeTx: rec.takeTx,
    withdraw: withdrawals.at(-1) ?? null,
    withdrawals,
    withdrawal: withdrawalStatus(rec),
    ...(rec.state === 'partial' ? { partial: partialView(rec) } : {}),
    ...(rec.outcome ? { outcome: rec.outcome } : {}),
    ...(rec.reason ? { reason: rec.reason } : {}),
    ...(rec.message ? { message: rec.message } : {}),
    ...(rec.state === 'failed' ? { recoverable: rec.recoverable === true } : {}),
    ...(rec.state === 'failed' && rec.retryAt !== undefined ? { retryAt: rec.retryAt } : {}),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

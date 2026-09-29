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
//   any non-terminal state ─► failed (with a reason); failed(funds-not-received) ─► awaiting_funds on re-open
//
// `minted` means "the temporary wallet holds the funds and the app acts next": after the deposit,
// after a lost take race ("Swap is not available"), and after a refunded withdrawal.

import type { StageEntry, SwapState, SwapView, SweepGas, WithdrawKind } from '@evm-midnight-transparent/core';

export type AttestedKind = 'success' | 'returned-false' | 'never-executed';

export interface LegRecord {
  colour: string;
  amount: string;
  symbol: string;
  erc20Address: string;
  decimals: number;
}

export interface DepositRecord {
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
}

export interface WithdrawRecord {
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
}

/** What the latest `/prove withdraw` validated: `/withdraw` must carry the same calls. */
export interface ProvenWithdraw {
  kind: WithdrawKind;
  callsDigest: string;
  coinNonce: string;
  evmNonce: string;
  at: number;
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
  proofs: { take: number; withdraw: number };
  provenWithdraw: ProvenWithdraw | null;
  withdrawals: WithdrawRecord[];
  outcome?: 'swapped' | 'bridged-back';
  reason?: string;
  message?: string;
  history: { state: SwapState; at: number }[];
  createdAt: number;
  updatedAt: number;
}

/** Which state may follow which. Anything else is a bug (or a replayed request) and throws. */
export const TRANSITIONS: Readonly<Record<SwapState, readonly SwapState[]>> = {
  awaiting_funds: ['depositing', 'failed'],
  depositing: ['minted', 'awaiting_funds', 'failed'],
  minted: ['taking', 'taken', 'withdrawing', 'bridging_back', 'failed'],
  taking: ['taken', 'minted', 'withdrawing', 'bridging_back', 'failed'],
  taken: ['withdrawing', 'failed'],
  withdrawing: ['done', 'minted', 'failed'],
  bridging_back: ['done', 'minted', 'failed'],
  done: [],
  failed: ['awaiting_funds'],
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
  extra: { reason?: string; message?: string } = {},
) {
  if (!canTransition(rec.state, to)) throw new TransitionError(rec.state, to);
  rec.state = to;
  rec.history.push({ state: to, at: now });
  if (rec.history.length > 100) rec.history.splice(0, rec.history.length - 100);
  rec.updatedAt = now;
  if (to === 'failed') {
    rec.reason = extra.reason ?? 'failed';
    rec.message = extra.message ?? 'the swap failed';
  } else {
    delete rec.reason;
    delete rec.message;
  }
}

export const isTerminal = (s: SwapState) => s === 'done' || s === 'failed';

/** The states in which the temporary wallet may hold a coin the app can move. */
export const WALLET_HOLDS_FUNDS: readonly SwapState[] = ['minted', 'taking', 'taken'];

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

function withdrawView(w: WithdrawRecord) {
  return {
    kind: w.kind,
    colour: w.colour,
    amount: w.amount,
    stage: w.stage,
    stages: copyStages(w.stages),
    refunds: w.refunds,
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
  const w = currentWithdrawal(rec);
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
    withdraw: w ? withdrawView(w) : null,
    withdrawals: rec.withdrawals.map(withdrawView),
    ...(rec.outcome ? { outcome: rec.outcome } : {}),
    ...(rec.reason ? { reason: rec.reason } : {}),
    ...(rec.message ? { message: rec.message } : {}),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

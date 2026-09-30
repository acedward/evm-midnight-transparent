// The swap page's decisions, as pure functions (unit-tested without a browser):
//
//   applyView     the sponsor's view of the swap, merged into the page's record (ids, hashes, stages,
//                 the phase);
//   nextAction    what the page does next with that record: fund, wait, look at the temporary wallet,
//                 wait for the user's Bridge back, or stop;
//   withdrawalStatus  what the sponsor says about the withdrawals (P4.2-fix C1): how many ended
//                 without a transfer, and whether one must be built now (a refund or a failed start
//                 sends the swap back to `minted` with `withdrawal.retry`);
//   afterMint     once the bridged coin is minted, what the temporary wallet's balances say to do:
//                 take, bridge out the received token, bridge back the paid token, or wait. The page
//                 decides from its own record, the wallet and the sponsor's withdrawal signal, not
//                 from the state's name, so a refund (back to `minted`, Q9 A), a failed start and a
//                 resume all land on the right step;
//   stageStates   the six stages the page shows, and which one is current.

import type { WithdrawalLast } from '@evm-midnight-transparent/core';

import type { SwapPhase, SwapRecord } from './record-shape.js';
import type { SponsorStage, SwapView } from './sponsor-client.js';

/** Refunded withdrawals are rebuilt automatically this many times, then the page asks. */
export const MAX_AUTO_RETRIES = 3;

const MAX_STAGES = 32;
/** Stage times arrive as unix seconds or milliseconds; the record keeps milliseconds. */
const toMs = (at: number) => (at < 1e12 ? Math.round(at * 1000) : Math.round(at));
const stagesOf = (s: readonly SponsorStage[] | undefined) =>
  s?.slice(-MAX_STAGES).map((x) => ({ stage: x.stage.slice(0, 64), at: Math.max(0, toMs(x.at)) }));

/** Keep only defined fields (the record's shape is strict and has no `undefined` slots). */
function defined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

const HASH = /^(0x)?[0-9a-fA-F]{8,140}$/;
const hashOr = (v: string | undefined, fallback: string | undefined) =>
  v !== undefined && HASH.test(v) ? v : fallback;

function phaseFor(record: SwapRecord, view: SwapView): SwapPhase {
  switch (view.state) {
    case 'awaiting_funds':
      return 'funding';
    case 'depositing':
      return 'bridging-in';
    case 'minted':
    case 'taking':
    case 'taken':
      if (record.choice === 'bridge-back') return 'bridging-back';
      if (record.phase === 'unavailable') return 'unavailable';
      if (record.take.tx || record.take.landed || view.takeTx || view.state === 'taken') return 'bridging-out';
      return 'taking';
    case 'withdrawing':
      return 'bridging-out';
    case 'bridging_back':
      return 'bridging-back';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
  }
}

export interface WithdrawalStatus {
  /** Withdrawals that ended without a transfer (refunded, or their start failed). */
  ended: number;
  /** The page must build a withdrawal now (none yet, or the latest ended without a transfer). */
  rebuild: boolean;
  /** How the latest one ended, when it ended without a transfer. */
  last: WithdrawalLast | null;
}

const ENDED_STAGES: Readonly<Record<string, WithdrawalLast>> = {
  refunded: 'refunded',
  failed: 'start-failed',
};

/** The sponsor's word on the withdrawals (P4.2-fix C1). Never the page's own counters: they missed
 *  every failed start, and the sponsor's `withdraw.refunds` once counted only the refunds BEFORE the
 *  latest attempt (the audit's F-A1). */
export function withdrawalStatus(view: SwapView): WithdrawalStatus {
  const s = view.withdrawal;
  if (s) {
    const last = s.last ?? null;
    const ended = s.attempts > 0 ? s.attempts - (last === null ? 1 : 0) : 0;
    return { ended, rebuild: s.retry || s.attempts === 0, last };
  }
  // A sponsor without the signal (before P4.2-fix, whose `refunds` counted the refunds BEFORE the
  // withdrawal): the latest withdrawal's stage says whether it ended.
  const w = view.withdraw;
  if (!w) return { ended: 0, rebuild: true, last: null };
  const last = ENDED_STAGES[w.stage ?? ''] ?? null;
  return { ended: (w.refunds ?? 0) + (last ? 1 : 0), rebuild: last !== null, last };
}

/** The record with the sponsor's view of the swap merged in. */
export function applyView(record: SwapRecord, view: SwapView, now: number): SwapRecord {
  const d = view.deposit;
  const bridgeIn = d
    ? defined({
        requestId: hashOr(d.requestId, record.bridgeIn.requestId),
        stage: d.stage?.slice(0, 64) ?? record.bridgeIn.stage,
        stages: stagesOf(d.stages) ?? record.bridgeIn.stages,
        startTx: hashOr(d.startTx, record.bridgeIn.startTx),
        sweepTx: hashOr(d.sweepTx, record.bridgeIn.sweepTx),
        completeTx: hashOr(d.completeTx, record.bridgeIn.completeTx),
      })
    : record.bridgeIn;

  let bridgeOut = record.bridgeOut;
  const w = view.withdraw;
  if (w) {
    const prev = record.bridgeOut;
    const newRequest = w.requestId !== undefined && prev.requestId !== undefined && w.requestId !== prev.requestId;
    const earlier = newRequest
      ? [
          ...(prev.earlier ?? []),
          defined({
            requestId: prev.requestId,
            startTx: prev.startTx,
            sepoliaTx: prev.sepoliaTx,
            completeTx: prev.completeTx,
          }),
        ].slice(-8)
      : prev.earlier;
    const keep = newRequest ? {} : prev;
    bridgeOut = defined({
      colour: w.colour && /^[0-9a-f]{64}$/.test(w.colour) ? w.colour : prev.colour,
      requestId: hashOr(w.requestId, keep.requestId),
      stage: w.stage?.slice(0, 64) ?? (newRequest ? undefined : prev.stage),
      stages: stagesOf(w.stages) ?? (newRequest ? undefined : prev.stages),
      startTx: hashOr(w.startTx, keep.startTx),
      sepoliaTx: hashOr(w.sepoliaTx, keep.sepoliaTx),
      completeTx: hashOr(w.completeTx, keep.completeTx),
      attempts: prev.attempts,
      // Withdrawals that ended without a transfer (refunded or not started), from the sponsor's signal.
      refunds: Math.min(100, Math.max(withdrawalStatus(view).ended, prev.refunds ?? 0)) || undefined,
      earlier,
    });
  }

  const take =
    view.takeTx && !record.take.tx && HASH.test(view.takeTx) ? { ...record.take, tx: view.takeTx } : record.take;
  const phase = phaseFor({ ...record, take }, view);
  const next: SwapRecord = { ...record, bridgeIn, bridgeOut, take, phase, updatedAt: now };
  if (view.state === 'done')
    next.outcome = view.outcome ?? (record.choice === 'bridge-back' ? 'bridged-back' : 'swapped');
  if (view.state === 'failed') {
    next.error = (view.message ?? view.reason ?? 'The sponsor stopped this swap.').slice(0, 500);
    // P4.2-fix C5: a failure the sponsor can revive by a re-open; the page offers Resume.
    if (view.recoverable === true) next.recoverable = true;
    else delete next.recoverable;
  } else if (record.phase === 'failed') {
    // Revived by a re-open: the failure is over.
    delete next.error;
    delete next.recoverable;
  }
  return next;
}

export type NextAction =
  /** The sponsor waits for the funds: the page offers "Send funds" (or waits for its receipts). */
  | 'fund'
  /** The sponsor is working (bridge-in, or a withdrawal): poll again. */
  | 'wait'
  /** The coin is minted: read the temporary wallet (`afterMint`). */
  | 'after-mint'
  /** "Swap is not available": wait for the user's Bridge back. */
  | 'unavailable'
  | 'finished';

export function nextAction(record: SwapRecord, view: SwapView): NextAction {
  switch (view.state) {
    case 'awaiting_funds':
      return 'fund';
    case 'depositing':
    case 'withdrawing':
    case 'bridging_back':
      return 'wait';
    case 'minted':
    case 'taking':
    case 'taken':
      return record.phase === 'unavailable' && record.choice === 'swap' ? 'unavailable' : 'after-mint';
    case 'done':
    case 'failed':
      return 'finished';
  }
}

export type MintedAction =
  | 'take'
  | 'withdraw-receive'
  | 'withdraw-pay'
  /** The sponsor holds a withdrawal that has not ended: it moves on. */
  | 'wait-withdrawal'
  /** The coin the next step needs is not visible yet: sync again. */
  | 'wait-coin'
  | 'unavailable';

/** What to do with the minted coin, from the record, the temporary wallet's balances, and the
 *  sponsor's withdrawal signal (`withdrawalStatus` of its latest view; P4.2-fix C1). */
export function afterMint(
  record: SwapRecord,
  balances: Readonly<Record<string, bigint>>,
  withdrawal: Pick<WithdrawalStatus, 'rebuild'>,
): MintedAction {
  const held = (colour: string) => balances[colour] ?? 0n;
  const receiveHeld = held(record.offer.receive.colour) >= BigInt(record.offer.receive.amount);
  const payHeld = held(record.offer.pay.colour) >= BigInt(record.offer.pay.amount);
  if (!withdrawal.rebuild) return 'wait-withdrawal';
  if (receiveHeld) return 'withdraw-receive';
  if (payHeld) {
    if (record.choice === 'bridge-back') return 'withdraw-pay';
    if (record.phase === 'unavailable') return 'unavailable';
    // A take already landed (its coin not synced yet): never take twice.
    if (record.take.tx || record.take.landed) return 'wait-coin';
    return 'take';
  }
  return 'wait-coin';
}

/** When the bridge-in began, for the page's "so far": the first sponsor stage once the funds are
 *  there. The real sponsor's list starts with `waiting-for-funds` when the swap OPENS, which can be
 *  long before the user sends the funds (plan P3: a swap funded 20 minutes after it opened showed
 *  "19 min 52 s so far" 30 seconds into its bridge-in). */
export function bridgeInStartedAt(record: SwapRecord): number | undefined {
  return record.bridgeIn.stages?.find((s) => s.stage !== 'waiting-for-funds')?.at;
}

export const STAGE_KEYS = ['start', 'fund', 'bridge-in', 'take', 'bridge-out', 'done'] as const;
export type StageKey = (typeof STAGE_KEYS)[number];
export type StageState = 'done' | 'current' | 'pending' | 'failed';

const PHASE_STAGE: Record<SwapPhase, number> = {
  funding: 1,
  'bridging-in': 2,
  taking: 3,
  unavailable: 3,
  'bridging-out': 4,
  'bridging-back': 4,
  done: 5,
  failed: -1,
};

/** Where a failed swap stopped: the last stage it reached. */
function failedStage(r: SwapRecord): number {
  if (r.bridgeOut.requestId || r.take.tx || r.take.landed || r.choice === 'bridge-back') return 4;
  if (r.bridgeIn.completeTx) return 3;
  if (r.bridgeIn.requestId || r.funding.token) return 2;
  return 1;
}

/** The six stages' states: before the record exists (`null`), the start is current. */
export function stageStates(record: SwapRecord | null): Record<StageKey, StageState> {
  const out = Object.fromEntries(STAGE_KEYS.map((k) => [k, 'pending'])) as Record<StageKey, StageState>;
  if (record === null) {
    out.start = 'current';
    return out;
  }
  const failed = record.phase === 'failed';
  const at = failed ? failedStage(record) : PHASE_STAGE[record.phase];
  STAGE_KEYS.forEach((k, i) => {
    out[k] = i < at ? 'done' : i === at ? (failed ? 'failed' : 'current') : 'pending';
  });
  if (record.phase === 'done') out.done = 'done';
  // The offer was gone: the take stage failed, whatever happens after.
  if (record.choice === 'bridge-back' || record.phase === 'unavailable') out.take = 'failed';
  return out;
}

/** Plain titles for the sponsor's stage ids, per leg (the real sponsor's, sponsor/src/swaps/service.ts,
 *  and the mock's `settled`); an unknown id is shown as it came. */
export const SPONSOR_STAGE_TITLES: Readonly<Record<'deposit' | 'withdraw', Readonly<Record<string, string>>>> = {
  deposit: {
    'waiting-for-funds': 'Waiting for your funds at the deposit address',
    'funds-seen': 'Your funds reached the deposit address',
    starting: 'Starting the deposit on Midnight',
    adopted: 'Deposit found on Midnight',
    started: 'Deposit started on Midnight',
    'mpc-signed': 'Sweep signed by the MPC network',
    'evm-broadcast': 'Sweep sent on Sepolia',
    'evm-not-broadcast': 'The sweep could not be sent on Sepolia',
    'evm-final': 'Sweep final on Sepolia',
    attested: 'Sweep attested by the MPC network',
    'relay-stalled': 'Waiting on the bridge (the sponsor retries)',
    completing: 'Minting to the temporary wallet',
    completed: 'Minted to the temporary wallet',
    settled: 'Minted to the temporary wallet',
    abandoning: 'The sweep did not happen: closing the request',
    abandoned: 'The sweep did not happen: the deposit will be retried',
    closed: 'Deposit request closed',
  },
  withdraw: {
    queued: 'Waiting for the withdrawal lane',
    starting: 'Starting the withdrawal on Midnight',
    submitting: 'Submitting the withdrawal on Midnight',
    started: 'Withdrawal started on Midnight',
    resumed: 'Withdrawal resumed by the sponsor',
    'mpc-signed': 'Transfer signed by the MPC network',
    'evm-broadcast': 'Tokens sent to you on Sepolia',
    'evm-not-broadcast': 'The Sepolia transfer could not be sent',
    'evm-final': 'Transfer final on Sepolia',
    'evm-failed': 'The Sepolia transfer failed',
    attested: 'Transfer attested by the MPC network',
    'relay-stalled': 'Waiting on the bridge (the sponsor retries)',
    completing: 'Closing the withdrawal on Midnight',
    completed: 'Withdrawal closed on Midnight',
    settled: 'Withdrawal closed on Midnight',
    refunded: 'Refunded to the temporary wallet',
    failed: 'The withdrawal failed',
  },
};

export const stageTitle = (leg: 'deposit' | 'withdraw', id: string) => SPONSOR_STAGE_TITLES[leg][id] ?? id;

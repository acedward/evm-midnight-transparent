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
//   stageStates   the six stages the page shows, and which one is current: all done once every token
//                 arrived at the user's address, verified on Sepolia, while the bridge closes the
//                 request in the background (P4.2-fix4, ./arrival.ts);
//   stageTitle    a human title for every stage id the sponsor writes.
//
// A PARTIAL deposit (P4.2-fix3 S2, ./partial.ts; the sponsor's state `partial`: part of the pay
// amount minted to the temporary wallet, the rest still at the deposit address) is its own next
// action: the user chooses "Wait for the rest" or "Bridge back" what arrived; the page never waits
// for it silently, and never sends the token again.

import type { WithdrawalLast } from '@evm-midnight-transparent/core';

import { clockText } from './display.js';
import { bridgeBackAmount, partialOf, partialRecord } from './partial.js';

import { type SwapPhase, type SwapRecord, isDoneForUser } from './record-shape.js';
import { lostRecord } from './settled-elsewhere.js';
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
    case 'partial':
      // S2: part of the funds is in the temporary wallet; the rest bridges in, or it all goes back.
      return record.choice === 'bridge-back' ? 'bridging-back' : 'bridging-in';
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

/** A withdrawal that moved the funds and is closed (the real sponsor's `completed`, the mock's
 *  `settled`). */
const SETTLED_STAGES = new Set(['completed', 'settled']);

/** The sponsor's word on the withdrawals (P4.2-fix C1). Never the page's own counters: they missed
 *  every failed start, and the sponsor's `withdraw.refunds` once counted only the refunds BEFORE the
 *  latest attempt (the audit's F-A1). */
export function withdrawalStatus(view: SwapView): WithdrawalStatus {
  const s = view.withdrawal;
  if (s) {
    const last = s.last ?? null;
    // Every attempt but a running or settled latest one ended without a transfer, except an EARLIER
    // one that settled: a Bridge back of a partial deposit is followed by another one for the rest
    // (P4.2-fix3 S2); the sponsor's `withdrawals` list names them.
    const settledEarlier = (view.withdrawals ?? [])
      .slice(0, -1)
      .filter((w) => SETTLED_STAGES.has(w.stage ?? '')).length;
    const ended = s.attempts > 0 ? Math.max(0, s.attempts - (last === null ? 1 : 0) - settledEarlier) : 0;
    // In `partial` no withdrawal runs (a running one is `bridging_back`): after a settled Bridge back
    // of what arrived, the next part is bridged back too (S2).
    const nextPart = view.state === 'partial' && last === null && SETTLED_STAGES.has(view.withdraw?.stage ?? '');
    return { ended, rebuild: s.retry || s.attempts === 0 || nextPart, last };
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
      // The page's own (P4.2-fix5 U4): the nonces its withdrawals signed, never the sponsor's word.
      evmNonces: prev.evmNonces,
      // Withdrawals that ended without a transfer (refunded or not started), from the sponsor's signal.
      refunds: Math.min(100, Math.max(withdrawalStatus(view).ended, prev.refunds ?? 0)) || undefined,
      earlier,
    });
  }

  const take =
    view.takeTx && !record.take.tx && HASH.test(view.takeTx) ? { ...record.take, tx: view.takeTx } : record.take;
  // S2: a partial deposit, as the sponsor reports it now (on `partial`). Once the sponsor says the
  // temporary wallet holds the whole amount (`minted` and on: the rest arrived) it is over; while
  // the rest bridges in, while a Bridge back of what arrived runs, and after it, the last report
  // stays on the record (the page says what came back and what stayed).
  const reported = partialRecord(record, view);
  const whole = ['minted', 'taking', 'taken', 'withdrawing'].includes(view.state);
  const partial = reported ?? (whole ? undefined : record.partial);
  const base: SwapRecord = { ...record, bridgeIn, bridgeOut, take };
  if (partial) base.partial = partial;
  else delete base.partial;
  // T1 (FS4): what another party's vault settle minted out of the temporary wallet's reach.
  const lost = lostRecord(record, view);
  if (lost) base.lost = lost;
  else delete base.lost;
  const phase = phaseFor(base, view);
  const next: SwapRecord = { ...base, phase, updatedAt: now };
  if (view.state === 'done')
    next.outcome = view.outcome ?? (record.choice === 'bridge-back' ? 'bridged-back' : 'swapped');
  if (view.state === 'failed') {
    next.error = (view.message ?? view.reason ?? 'The sponsor stopped this swap.').slice(0, 500);
    // P4.2-fix C5: a failure the sponsor can revive by a re-open; the page offers Resume. Its "no" is
    // kept as `false` (P4.2-fix2 R3): a record without the field is one the sponsor was not asked
    // about yet (written before), and the page offers Resume for it.
    next.recoverable = view.recoverable === true;
  } else if (record.phase === 'failed') {
    // Revived by a re-open: the failure is over.
    delete next.error;
    delete next.recoverable;
  }
  return next;
}

/** A recoverable failure the sponsor revives only after its re-arm cooldown (`retryAt`, FS2 R3):
 *  the sentence that says from when a Resume works; null otherwise. */
export function revivalNote(view: SwapView, now: number): string | null {
  if (view.state !== 'failed' || view.recoverable !== true || view.retryAt === undefined) return null;
  const at = view.retryAt * 1000;
  return at > now ? `The sponsor can revive this swap from ${clockText(at)}: resume it then.` : null;
}

export type NextAction =
  /** The sponsor waits for the funds: the page offers "Send funds" (or waits for its receipts). */
  | 'fund'
  /** A partial deposit (S2): the user chooses "Wait for the rest" or "Bridge back" what arrived; while
   *  the rest is awaited, only the sweep ETH may be topped up (never the token). */
  | 'partial'
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
    case 'partial': {
      // S2: the user chose to bridge back what arrived, and the temporary wallet holds some of it:
      // build that withdrawal. Otherwise the choice, or the wait for the rest.
      const p = partialOf(view, BigInt(record.offer.pay.amount));
      if (p?.canBridgeBack && record.choice === 'bridge-back') return 'after-mint';
      return 'partial';
    }
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
  // S2: Bridge back of a partial deposit: what the temporary wallet received, once it shows there.
  if (record.partial && record.choice === 'bridge-back') {
    const amount = bridgeBackAmount(record);
    return amount > 0n && held(record.offer.pay.colour) >= amount ? 'withdraw-pay' : 'wait-coin';
  }
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
  // P4.2-fix4: every token arrived at the user's address (verified): done, while the bridge closes.
  const phase: SwapPhase = isDoneForUser(record) ? 'done' : record.phase;
  const at = failed ? failedStage(record) : PHASE_STAGE[phase];
  STAGE_KEYS.forEach((k, i) => {
    out[k] = i < at ? 'done' : i === at ? (failed ? 'failed' : 'current') : 'pending';
  });
  if (phase === 'done') out.done = 'done';
  // The offer was gone: the take stage failed, whatever happens after.
  if (record.choice === 'bridge-back' || record.phase === 'unavailable') out.take = 'failed';
  return out;
}

/**
 * Plain titles for the sponsor's stage ids (the real sponsor's, sponsor/src/swaps/service.ts, and the
 * mock's `settled` and `evm-failed`). A leg's own words first (`deposit`: the bridge-in list,
 * `withdraw`: the bridge-out list), then `shared`: the ids that read the same in either list, or that
 * only one leg emits. web/test/fix4-stage-titles.test.ts reads every stage id the sponsor's code can
 * write and fails when one has no title in either list (P4.2-fix4: the owner saw "evm-pending"
 * untitled in both). An id this page does not know yet is still shown as it came.
 */
export const SPONSOR_STAGE_TITLES: Readonly<
  Record<'deposit' | 'withdraw' | 'shared', Readonly<Record<string, string>>>
> = {
  deposit: {
    starting: 'Starting the deposit on Midnight',
    adopted: 'Deposit found on Midnight',
    started: 'Deposit started on Midnight',
    'mpc-signed': 'Sweep signed by the MPC network',
    'evm-broadcast': 'Sweep mined on Sepolia',
    'evm-not-broadcast': 'The sweep could not be sent on Sepolia',
    'evm-final': 'Sweep final on Sepolia',
    attested: 'Sweep attested by the MPC network',
    completing: 'Minting to the temporary wallet',
    completed: 'Minted to the temporary wallet',
    settled: 'Minted to the temporary wallet',
    // P4.2-fix4 FS4 (Lane contracts, FS4 item 4): a settle the sponsor did not track; a lost amount
    // is the sponsor's own note on the page.
    'settled-elsewhere': 'Deposit request found completed on Midnight',
  },
  withdraw: {
    starting: 'Starting the withdrawal on Midnight',
    adopted: 'Withdrawal found on Midnight',
    started: 'Withdrawal started on Midnight',
    'mpc-signed': 'Transfer signed by the MPC network',
    'evm-broadcast': 'Transfer to you mined on Sepolia',
    'evm-not-broadcast': 'The Sepolia transfer could not be sent',
    'evm-final': 'Transfer final on Sepolia',
    attested: 'Transfer attested by the MPC network',
    completing: 'Closing the withdrawal on Midnight',
    completed: 'Withdrawal closed on Midnight',
    settled: 'Withdrawal closed on Midnight',
    'settled-elsewhere': 'Withdrawal request found completed on Midnight',
  },
  shared: {
    // The relay sent the MPC-signed transaction and waits for Sepolia to mine it (both legs).
    'evm-pending': 'Waiting for the Sepolia transaction',
    'relay-stalled': 'Waiting on the bridge (the sponsor retries)',
    // The deposit leg's own ids.
    'waiting-for-funds': 'Waiting for your funds at the deposit address',
    'funds-seen': 'Your funds reached the deposit address',
    'budget-wait': "Waiting for room in the sponsor's daily budget",
    abandoning: 'The sweep did not happen: closing the request',
    abandoned: 'The sweep did not happen: the deposit will be retried',
    'completed-foreign': 'Another request swept the deposit address: the sponsor completed it',
    // P4.2-fix3 S2 (FS3 item 8): part of the pay amount reached the temporary wallet.
    partial: 'Part of your deposit reached the temporary wallet',
    'rearm-wait': 'Waiting to start the deposit of the rest (the sponsor paces them)',
    closed: 'Deposit request closed',
    // The withdrawal leg's own ids.
    queued: 'Waiting for the withdrawal lane',
    submitting: 'Submitting the withdrawal on Midnight',
    'submission-uncertain': 'Checking whether the withdrawal reached Midnight',
    resumed: 'Withdrawal resumed by the sponsor',
    'evm-failed': 'The Sepolia transfer failed',
    refunded: 'Refunded to the temporary wallet',
    failed: 'The withdrawal failed',
  },
};

const ownTitle = (table: Readonly<Record<string, string>>, id: string) =>
  Object.hasOwn(table, id) ? table[id] : undefined;

export const stageTitle = (leg: 'deposit' | 'withdraw', id: string): string =>
  ownTitle(SPONSOR_STAGE_TITLES[leg], id) ?? ownTitle(SPONSOR_STAGE_TITLES.shared, id) ?? id;

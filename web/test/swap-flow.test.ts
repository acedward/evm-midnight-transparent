// The swap page's pure logic: which offers are listed (45 minutes), prices and times as text, the
// sponsor's view merged into the record, what to do next, what to do with the minted coin, and the
// six stages' states. Expected values are written out by hand.

import type { BookSnapshot, SwapOffer } from '@evm-midnight-transparent/core';
import { describe, expect, it } from 'vitest';

import {
  afterMint,
  applyView,
  bridgeInStartedAt,
  nextAction,
  stageStates,
  stageTitle,
  withdrawalStatus,
} from '../src/swap/flow.js';
import {
  MIN_TIME_TO_EXPIRY_MS,
  formatPriceRatio,
  formatTimeLeft,
  invert,
  lastsLongEnough,
  listOffers,
} from '../src/swap/offers.js';
import { type SwapRecord, SwapRecordSchema, isResumable, swapIdOf } from '../src/swap/record-shape.js';
import type { SwapView } from '../src/swap/sponsor-client.js';
import { registry } from './swap-fixtures.js';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const tok = (n: string) => registry.byMidnightName(n)!;

function offer(id: string, pay: [string, bigint], receive: [string, bigint], expiresInMs: number | null): SwapOffer {
  const p = tok(pay[0]);
  const r = tok(receive[0]);
  return {
    offerId: id.padStart(64, '0'),
    pay: { token: p, amount: pay[1] },
    receive: { token: r, amount: receive[1] },
    // whole pay per whole receive (both 6 decimals here)
    price: { num: pay[1], den: receive[1] },
    expiresAt: expiresInMs === null ? null : new Date(NOW + expiresInMs).toISOString(),
    firstSeenAt: null,
  };
}

describe('the offers list', () => {
  it('leaves out offers expiring within 45 minutes (not 45:00 exactly), keeps unknown expiries', () => {
    expect(lastsLongEnough({ expiresAt: new Date(NOW + MIN_TIME_TO_EXPIRY_MS).toISOString() }, NOW)).toBe(false);
    expect(lastsLongEnough({ expiresAt: new Date(NOW + MIN_TIME_TO_EXPIRY_MS + 1).toISOString() }, NOW)).toBe(true);
    expect(lastsLongEnough({ expiresAt: null }, NOW)).toBe(true);
    const snap: BookSnapshot = {
      offers: [
        offer('1', ['wUSDC', 1_080_000n], ['wStkA', 100_000_000n], 86_400_000),
        offer('2', ['wUSDC', 1_040_000n], ['wStkA', 100_000_000n], 86_400_000),
        offer('3', ['wUSDC', 1_000_000n], ['wStkA', 100_000_000n], 30 * 60_000),
        offer('4', ['wStkB', 5_000_000n], ['wStkA', 5_000_000n], null),
        offer('5', ['wStkA', 104_166_667n], ['wUSDC', 1_000_000n], 86_400_000),
      ],
      ignored: {
        'one-sided': 0,
        basket: 0,
        unshielded: 0,
        'not-bridgeable': 0,
        'same-token': 0,
        'zero-amount': 0,
        duplicate: 0,
      },
    };
    const listed = listOffers(snap, NOW);
    expect(listed.expiringSoon).toBe(1);
    // Grouped by (pay, receive) Midnight names, the lowest price first.
    expect(listed.offers.map((o) => o.offerId.replace(/^0+/, ''))).toEqual(['5', '4', '2', '1']);
  });

  it('writes prices exactly: six decimals above 1, four significant digits below, truncated', () => {
    expect(formatPriceRatio({ num: 104_166_667n, den: 1_000_000n })).toBe('104.166667');
    expect(formatPriceRatio({ num: 1_040_000n, den: 100_000_000n })).toBe('0.0104');
    expect(formatPriceRatio(invert({ num: 104_166_667n, den: 1_000_000n }))).toBe('0.009599');
    expect(formatPriceRatio({ num: 100n, den: 1n })).toBe('100.00');
    expect(formatPriceRatio({ num: 1_234_567n, den: 1n })).toBe('1,234,567.00');
    expect(formatPriceRatio({ num: 0n, den: 1n })).toBe('0');
  });

  it('writes times left', () => {
    expect(formatTimeLeft(null)).toBe('no expiry given');
    expect(formatTimeLeft(-1)).toBe('expired');
    expect(formatTimeLeft(50 * 60_000)).toBe('in 50 min');
    expect(formatTimeLeft(125 * 60_000)).toBe('in 2 h 5 min');
    expect(formatTimeLeft((13 * 24 + 4) * 3_600_000)).toBe('in 13 d 4 h');
  });
});

const H = (c: string) => c.repeat(64);
const SALT = `0x${H('5')}`;
const SWAP_ID = swapIdOf(SALT);

function record(patch: Partial<SwapRecord> = {}): SwapRecord {
  return {
    v: 2,
    swapId: SWAP_ID,
    salt: SALT,
    derivation: 2,
    network: 'stagenet',
    vault: H('7'),
    evmAddress: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
    deterministic: true,
    offer: {
      offerId: H('9'),
      pay: { colour: H('a'), symbol: 'USDC', midnightName: 'wUSDC', decimals: 6, amount: '1040000' },
      receive: { colour: H('b'), symbol: 'stkA', midnightName: 'wStkA', decimals: 6, amount: '100000000' },
      expiresAt: null,
    },
    temp: { coinPk: H('c'), encPk: H('d'), shieldedAddress: 'mn_shield-addr_stagenet1x' },
    deposit: {
      address: '0xFA0D1f6448c87d7a5ab437492Ca5865D68C4f55F',
      erc20Address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      amount: '1040000',
      sweepGas: { gasLimit: '65000', maxFeePerGas: '2500000000', ethWei: '162500000000000' },
    },
    funding: {},
    bridgeIn: {},
    take: {},
    choice: 'swap',
    bridgeOut: {},
    phase: 'funding',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

const view = (state: SwapView['state'], patch: Partial<SwapView> = {}): SwapView => ({
  swapId: SWAP_ID,
  state,
  ...patch,
});
const REBUILD = { rebuild: true };

describe("the sponsor's view, merged into the record", () => {
  it('maps every state to a phase', () => {
    const cases: Array<[SwapView['state'], Partial<SwapRecord>, SwapRecord['phase']]> = [
      ['awaiting_funds', {}, 'funding'],
      ['depositing', {}, 'bridging-in'],
      ['minted', {}, 'taking'],
      ['taking', {}, 'taking'],
      ['minted', { take: { tx: H('e') } }, 'bridging-out'],
      ['taken', {}, 'bridging-out'],
      ['minted', { phase: 'unavailable' }, 'unavailable'],
      ['minted', { choice: 'bridge-back', phase: 'unavailable' }, 'bridging-back'],
      ['withdrawing', {}, 'bridging-out'],
      ['bridging_back', {}, 'bridging-back'],
      ['done', {}, 'done'],
      ['failed', {}, 'failed'],
    ];
    for (const [state, patch, phase] of cases)
      expect(applyView(record(patch), view(state), 5).phase, state).toBe(phase);
  });

  it('keeps every hash, stage times in milliseconds, the outcome and the failure', () => {
    const r = applyView(
      record(),
      view('depositing', {
        deposit: {
          requestId: H('1'),
          startTx: `00${H('2')}`,
          stage: 'started',
          stages: [{ stage: 'starting', at: 1_700_000_000 }],
        },
      }),
      9,
    );
    expect(r.bridgeIn).toEqual({
      requestId: H('1'),
      startTx: `00${H('2')}`,
      stage: 'started',
      stages: [{ stage: 'starting', at: 1_700_000_000_000 }],
    });
    expect(r.updatedAt).toBe(9);
    expect(applyView(record(), view('done', { outcome: 'swapped' }), 1).outcome).toBe('swapped');
    expect(applyView(record({ choice: 'bridge-back' }), view('done'), 1).outcome).toBe('bridged-back');
    expect(applyView(record(), view('failed', { reason: 'the vault refused' }), 1).error).toBe('the vault refused');
    // A take the sponsor reports, when the page did not have it.
    expect(applyView(record(), view('taken', { takeTx: H('f') }), 1).take.tx).toBe(H('f'));
    // A malformed hash from the sponsor is not stored.
    expect(
      applyView(record(), view('depositing', { deposit: { requestId: 'not a hash' } }), 1).bridgeIn.requestId,
    ).toBeUndefined();
  });

  it('a refunded withdrawal: its ids move to `earlier` when a new request starts', () => {
    const first = applyView(
      record({ bridgeOut: { attempts: 1 } }),
      view('withdrawing', { withdraw: { colour: H('b'), requestId: H('1'), startTx: `00${H('2')}`, refunds: 0 } }),
      1,
    );
    // The real sponsor's wire: `refunds` counts the refunds BEFORE this withdrawal (0), the signal
    // says it ended refunded.
    const refundedView = view('minted', {
      withdraw: { colour: H('b'), requestId: H('1'), completeTx: `00${H('3')}`, stage: 'refunded', refunds: 0 },
      withdrawal: { attempts: 1, last: 'refunded', retry: true },
    });
    const refunded = applyView(first, refundedView, 2);
    expect(refunded.bridgeOut.refunds).toBe(1);
    expect(afterMint(refunded, { [H('b')]: 100_000_000n }, withdrawalStatus(refundedView))).toBe('withdraw-receive');
    const second = applyView(
      { ...refunded, bridgeOut: { ...refunded.bridgeOut, attempts: 2 } },
      view('withdrawing', { withdraw: { colour: H('b'), requestId: H('4'), refunds: 1 } }),
      3,
    );
    expect(second.bridgeOut.requestId).toBe(H('4'));
    expect(second.bridgeOut.startTx).toBeUndefined();
    expect(second.bridgeOut.earlier).toEqual([
      { requestId: H('1'), startTx: `00${H('2')}`, completeTx: `00${H('3')}` },
    ]);
  });
});

describe('the bridge-in timer', () => {
  it('counts from the funds arriving, not from the swap opening (the real sponsor lists waiting-for-funds first)', () => {
    const at = (stage: string, t: number) => ({ stage, at: t });
    const r = (stages: Array<{ stage: string; at: number }>) => record({ bridgeIn: { stages } });
    expect(
      bridgeInStartedAt(r([at('waiting-for-funds', 1_000), at('funds-seen', 1_200_000), at('started', 1_225_000)])),
    ).toBe(1_200_000);
    expect(bridgeInStartedAt(r([at('starting', 5), at('started', 9)]))).toBe(5); // the mock's list
    expect(bridgeInStartedAt(r([at('waiting-for-funds', 1_000)]))).toBeUndefined();
    expect(bridgeInStartedAt(record())).toBeUndefined();
  });
});

describe('what the page does next', () => {
  it('from the state', () => {
    expect(nextAction(record(), view('awaiting_funds'))).toBe('fund');
    expect(nextAction(record(), view('depositing'))).toBe('wait');
    expect(nextAction(record(), view('withdrawing'))).toBe('wait');
    expect(nextAction(record(), view('bridging_back'))).toBe('wait');
    expect(nextAction(record(), view('minted'))).toBe('after-mint');
    expect(nextAction(record({ phase: 'unavailable' }), view('minted'))).toBe('unavailable');
    expect(nextAction(record({ phase: 'unavailable', choice: 'bridge-back' }), view('minted'))).toBe('after-mint');
    expect(nextAction(record(), view('done'))).toBe('finished');
    expect(nextAction(record(), view('failed'))).toBe('finished');
  });

  it('with the minted coin, from the temporary wallet and the record', () => {
    const pay = { [H('a')]: 1_040_000n };
    const recv = { [H('b')]: 100_000_000n };
    const none = {};
    expect(afterMint(record(), pay, REBUILD)).toBe('take');
    expect(afterMint(record(), { [H('a')]: 1_039_999n }, REBUILD)).toBe('wait-coin');
    expect(afterMint(record(), none, REBUILD)).toBe('wait-coin');
    expect(afterMint(record(), recv, REBUILD)).toBe('withdraw-receive');
    // Never take twice: the take landed but its coin is not synced yet.
    expect(afterMint(record({ take: { tx: H('e') } }), pay, REBUILD)).toBe('wait-coin');
    expect(afterMint(record({ take: { landed: true } }), pay, REBUILD)).toBe('wait-coin');
    expect(afterMint(record({ phase: 'unavailable' }), pay, REBUILD)).toBe('unavailable');
    expect(afterMint(record({ choice: 'bridge-back' }), pay, REBUILD)).toBe('withdraw-pay');
    // The sponsor holds a withdrawal that has not ended: never build another.
    expect(afterMint(record({ bridgeOut: { attempts: 1 } }), recv, { rebuild: false })).toBe('wait-withdrawal');
  });
});

// P4.2-fix C1 (the audit's F-A1 / F-B3): against the REAL sponsor's wire the page waited forever
// after a refund or a failed start, because it decided "in flight" from its own counters and the
// sponsor's `withdraw.refunds` counts the refunds BEFORE the latest withdrawal. It now reads the
// sponsor's `withdrawal` signal (and, from a sponsor without it, the latest withdrawal's stage).
describe('a withdrawal that ended without a transfer (P4.2-fix C1, the real sponsor wire)', () => {
  const recv = { [H('b')]: 100_000_000n };
  const submitted = () => record({ phase: 'bridging-out', take: { tx: H('e') }, bridgeOut: { attempts: 1 } });
  /** The page: merge the sponsor's view, then decide with the wallet's balances. */
  const decide = (v: SwapView) => afterMint(applyView(submitted(), v, 2), recv, withdrawalStatus(v));

  it('refunded (the vault nonce was taken): rebuild and retry', () => {
    const v = view('minted', {
      takeTx: H('e'),
      withdraw: { colour: H('b'), requestId: H('1'), stage: 'refunded', refunds: 0 },
      withdrawal: { attempts: 1, last: 'refunded', retry: true },
    });
    expect(withdrawalStatus(v)).toEqual({ ended: 1, rebuild: true, last: 'refunded' });
    expect(decide(v)).toBe('withdraw-receive');
    expect(applyView(submitted(), v, 2).bridgeOut.refunds).toBe(1);
  });

  it('a start that failed at the head of the lane (stale vault state or nonce): rebuild and retry', () => {
    for (const last of ['start-failed', 'stale-vault'] as const) {
      const v = view('minted', {
        takeTx: H('e'),
        withdraw: { colour: H('b'), stage: 'failed', refunds: 0 },
        withdrawal: { attempts: 1, last, retry: true },
      });
      expect(decide(v), last).toBe('withdraw-receive');
    }
  });

  it('a sponsor without the signal: the latest withdrawal stage says it ended', () => {
    for (const stage of ['refunded', 'failed']) {
      const v = view('minted', { takeTx: H('e'), withdraw: { colour: H('b'), stage, refunds: 0 } });
      expect(decide(v), stage).toBe('withdraw-receive');
    }
    expect(withdrawalStatus(view('minted'))).toEqual({ ended: 0, rebuild: true, last: null });
  });

  it('counts every ended attempt for the "ask after 3" rule, from the signal', () => {
    const v = view('minted', {
      withdraw: { colour: H('b'), stage: 'refunded', refunds: 2 },
      withdrawal: { attempts: 3, last: 'refunded', retry: true },
    });
    expect(withdrawalStatus(v).ended).toBe(3);
    const inFlight = view('withdrawing', {
      withdraw: { colour: H('b'), stage: 'started', refunds: 1 },
      withdrawal: { attempts: 2, retry: false },
    });
    expect(withdrawalStatus(inFlight)).toMatchObject({ ended: 1 });
  });

  it('never builds while the sponsor holds a withdrawal that has not ended', () => {
    const v = view('minted', { takeTx: H('e'), withdrawal: { attempts: 1, retry: false } });
    expect(decide(v)).toBe('wait-withdrawal');
  });
});

// P4.2-fix C5: a failure the sponsor can revive (`recoverable`) is resumable; others stay terminal.
describe('a recoverable failure (P4.2-fix C5)', () => {
  it('is kept on the record, offered for Resume, and cleared once the swap is revived', () => {
    const failed = applyView(record(), view('failed', { reason: 'funds-not-received', recoverable: true }), 1);
    expect(failed).toMatchObject({ phase: 'failed', recoverable: true, error: 'funds-not-received' });
    expect(isResumable(failed)).toBe(true);
    // A view that does not say (a sponsor before P4.2-fix) is the sponsor's "no" (P4.2-fix2 R3: the
    // record keeps it as `false`; only a record that does not say at all is asked again).
    const terminal = applyView(record(), view('failed', { reason: 'deposit-returned-false' }), 1);
    expect(terminal.recoverable).toBe(false);
    expect(isResumable(terminal)).toBe(false);
    const revived = applyView(failed, view('awaiting_funds'), 2);
    expect(revived.phase).toBe('funding');
    expect(revived.recoverable).toBeUndefined();
    expect(revived.error).toBeUndefined();
    expect(isResumable(revived)).toBe(true);
  });
});

// P4.2-fix2 R3 (the audit's F-B25, the page's part): a failed record that does not say whether it is
// recoverable (written before P4.2-fix, or by the page that dropped a sponsor's "no") is not final:
// only the sponsor can tell, per its migration, so the page offers Resume (a re-open asks it). The
// sponsor's "no" is now kept as `false`, so it is asked once, not forever.
describe('a failed record that does not say whether it is recoverable (P4.2-fix2 R3, F-B25)', () => {
  it("keeps the sponsor's no as false: final, no Resume", () => {
    const no = applyView(record(), view('failed', { reason: 'deposit-attempts', recoverable: false }), 1);
    expect(no).toMatchObject({ phase: 'failed', recoverable: false });
    expect(isResumable(no)).toBe(false);
  });

  it('offers Resume for a legacy failed record (no `recoverable`): the re-open asks the sponsor', () => {
    const legacy = record({ phase: 'failed', error: 'The deposit sweep did not execute.' });
    expect(legacy.recoverable).toBeUndefined();
    expect(isResumable(legacy)).toBe(true);
    // A version-1 record (before P4.2-fix) that failed: the same.
    const { salt: _salt, ...v1 } = { ...legacy, v: 1, swapId: SALT, derivation: 1 };
    const parsed = SwapRecordSchema.parse(v1);
    expect(isResumable(parsed)).toBe(true);
    // The re-open's answer settles it: revived (any other state), or failed with the sponsor's word.
    expect(isResumable(applyView(legacy, view('failed', { recoverable: false }), 2))).toBe(false);
    expect(applyView(legacy, view('awaiting_funds'), 2)).toMatchObject({ phase: 'funding' });
    expect(applyView(legacy, view('awaiting_funds'), 2).recoverable).toBeUndefined();
  });
});

// P4.2-fix C14: the record keeps the salt (local only) next to the PUBLIC id derived from it.
describe('the record: the public id and the local salt (P4.2-fix C14)', () => {
  it("requires the id to be the salt's, and reads a version-1 record (id = salt) as legacy", () => {
    expect(SwapRecordSchema.safeParse(record()).success).toBe(true);
    expect(SwapRecordSchema.safeParse(record({ swapId: SALT })).success).toBe(false);
    const { salt: _salt, ...v1 } = { ...record(), v: 1, swapId: SALT, derivation: 1 };
    const parsed = SwapRecordSchema.safeParse(v1);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ v: 2, swapId: SALT, salt: SALT, derivation: 1 });
    // A version-1 record claiming derivation 2 is not one this page wrote.
    expect(SwapRecordSchema.safeParse({ ...v1, derivation: 2 }).success).toBe(false);
  });
});

describe('the six stages', () => {
  const states = (r: SwapRecord | null) => Object.values(stageStates(r)).join(' ');
  it('follow the phase', () => {
    expect(states(null)).toBe('current pending pending pending pending pending');
    expect(states(record())).toBe('done current pending pending pending pending');
    expect(states(record({ phase: 'bridging-in' }))).toBe('done done current pending pending pending');
    expect(states(record({ phase: 'taking' }))).toBe('done done done current pending pending');
    expect(states(record({ phase: 'bridging-out' }))).toBe('done done done done current pending');
    expect(states(record({ phase: 'done', outcome: 'swapped' }))).toBe('done done done done done done');
  });
  it('mark the take failed when the offer was gone, whatever follows', () => {
    expect(states(record({ phase: 'unavailable' }))).toBe('done done done failed pending pending');
    expect(states(record({ phase: 'bridging-back', choice: 'bridge-back' }))).toBe(
      'done done done failed current pending',
    );
    expect(states(record({ phase: 'done', choice: 'bridge-back', outcome: 'bridged-back' }))).toBe(
      'done done done failed done done',
    );
  });
  it('show where a failed swap stopped', () => {
    expect(states(record({ phase: 'failed' }))).toBe('done failed pending pending pending pending');
    expect(states(record({ phase: 'failed', bridgeIn: { requestId: H('1') } }))).toBe(
      'done done failed pending pending pending',
    );
    expect(states(record({ phase: 'failed', bridgeIn: { completeTx: H('1') } }))).toBe(
      'done done done failed pending pending',
    );
    expect(states(record({ phase: 'failed', take: { tx: H('1') } }))).toBe('done done done done failed pending');
  });
  it('titles the sponsor stages per leg, and shows an unknown one as it came', () => {
    expect(stageTitle('deposit', 'settled')).toBe('Minted to the temporary wallet');
    expect(stageTitle('withdraw', 'settled')).toBe('Withdrawal closed on Midnight');
    expect(stageTitle('withdraw', 'evm-broadcast')).toBe('Tokens sent to you on Sepolia');
    expect(stageTitle('deposit', 'something-new')).toBe('something-new');
  });
});

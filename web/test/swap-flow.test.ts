// The swap page's pure logic: which offers are listed (45 minutes), prices and times as text, the
// sponsor's view merged into the record, what to do next, what to do with the minted coin, and the
// six stages' states. Expected values are written out by hand.

import type { BookSnapshot, SwapOffer } from '@evm-midnight-transparent/core';
import { describe, expect, it } from 'vitest';

import { afterMint, applyView, nextAction, stageStates, stageTitle } from '../src/swap/flow.js';
import {
  MIN_TIME_TO_EXPIRY_MS,
  formatPriceRatio,
  formatTimeLeft,
  invert,
  lastsLongEnough,
  listOffers,
} from '../src/swap/offers.js';
import type { SwapRecord } from '../src/swap/record-shape.js';
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

function record(patch: Partial<SwapRecord> = {}): SwapRecord {
  return {
    v: 1,
    swapId: `0x${H('5')}`,
    derivation: 1,
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
  swapId: `0x${H('5')}`,
  state,
  ...patch,
});

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
    const refunded = applyView(
      first,
      view('minted', { withdraw: { colour: H('b'), requestId: H('1'), completeTx: `00${H('3')}`, refunds: 1 } }),
      2,
    );
    expect(refunded.bridgeOut.refunds).toBe(1);
    expect(afterMint(refunded, { [H('b')]: 100_000_000n })).toBe('withdraw-receive');
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
    expect(afterMint(record(), pay)).toBe('take');
    expect(afterMint(record(), { [H('a')]: 1_039_999n })).toBe('wait-coin');
    expect(afterMint(record(), none)).toBe('wait-coin');
    expect(afterMint(record(), recv)).toBe('withdraw-receive');
    // Never take twice: the take landed but its coin is not synced yet.
    expect(afterMint(record({ take: { tx: H('e') } }), pay)).toBe('wait-coin');
    expect(afterMint(record({ take: { landed: true } }), pay)).toBe('wait-coin');
    expect(afterMint(record({ phase: 'unavailable' }), pay)).toBe('unavailable');
    expect(afterMint(record({ choice: 'bridge-back' }), pay)).toBe('withdraw-pay');
    // A withdrawal in flight (submitted, not refunded): never build another.
    expect(afterMint(record({ bridgeOut: { attempts: 1 } }), recv)).toBe('wait-withdrawal');
    expect(afterMint(record({ bridgeOut: { attempts: 1, refunds: 1 } }), recv)).toBe('withdraw-receive');
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

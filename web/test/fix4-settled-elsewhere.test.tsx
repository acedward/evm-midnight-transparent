// Plan 00048 P4.2-fix4, lane FS4: the audit's T1 (F-A41), page side. Another party may settle a vault
// request of the swap first; the coin it mints has a nonce only that party knows, so the temporary
// wallet can never use it (questions file Q16). The sponsor reports it as `settledElsewhere` and
// moves the swap on (a `partial` deposit with Bridge back, or `failed` / `settled-elsewhere`). The page
// keeps the lost parts on the record and says what was lost; it never waits for a coin it cannot find.

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { STAGENET } from '@evm-midnight-transparent/core';

import { LostNotice } from '../src/pages/swap/LostNotice.js';
import { applyView, nextAction } from '../src/swap/flow.js';
import { SwapRecordSchema, type SwapRecord, swapIdOf } from '../src/swap/record-shape.js';
import { lostParts, lostRecord } from '../src/swap/settled-elsewhere.js';
import { SwapViewSchema, type SwapView } from '../src/swap/sponsor-client.js';

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
    funding: { token: { hash: `0x${H('e')}`, status: 'confirmed' } },
    bridgeIn: {},
    take: {},
    choice: 'swap',
    bridgeOut: {},
    phase: 'bridging-in',
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

/** The sponsor's wire (core's view, as JSON) through the page's own schema. */
const wire = (v: Record<string, unknown>): SwapView => SwapViewSchema.parse({ swapId: SWAP_ID.slice(2), ...v });

const LOST_DEPOSIT = {
  kind: 'deposit',
  requestId: H('1'),
  attested: 'success',
  colour: H('a'),
  amount: '1',
  lost: true,
  evmTx: `0x${H('f')}`,
  at: 100,
};

describe('T1 (FS4): what another party’s settle minted out of reach, on the page', () => {
  it('the page’s schema keeps the sponsor’s `settledElsewhere` (it strips unknown keys otherwise)', () => {
    const v = wire({ state: 'partial', settledElsewhere: [LOST_DEPOSIT] });
    expect(v.settledElsewhere).toHaveLength(1);
    expect(lostParts(v)).toEqual([
      { kind: 'deposit', colour: H('a'), amount: '1', requestId: H('1'), evmTx: `0x${H('f')}` },
    ]);
    // Nothing minted (a successful withdrawal or an abandon settled elsewhere): nothing lost.
    expect(lostParts(wire({ state: 'done', settledElsewhere: [{ ...LOST_DEPOSIT, lost: false }] }))).toEqual([]);
  });

  it('the record keeps the lost parts (strict shape, no secret), and an older sponsor’s view leaves them', () => {
    const r = applyView(
      record(),
      wire({
        state: 'partial',
        settledElsewhere: [LOST_DEPOSIT],
        partial: { minted: '0', remaining: '1039999', atAddress: '1039999', options: ['wait'] },
      }),
      3,
    );
    expect(r.lost).toEqual([{ kind: 'deposit', colour: H('a'), amount: '1', requestId: H('1'), evmTx: `0x${H('f')}` }]);
    expect(SwapRecordSchema.parse(r)).toEqual(r);
    expect(lostRecord(r, wire({ state: 'partial' }))).toEqual(r.lost);
    // A partial deposit after a loss: only the sweep ETH is waited for, never the token again.
    expect(
      nextAction(
        r,
        wire({
          state: 'partial',
          partial: { minted: '0', remaining: '1039999', atAddress: '1039999', options: ['wait'] },
        }),
      ),
    ).toBe('partial');
  });

  it('a swap whose funds were all lost ends with the sponsor’s sentence and no Resume', () => {
    const message =
      "Another party completed this swap's bridge request before the sponsor and kept the minted coin's details to itself: 1.04 USDC can no longer be used by this swap's temporary wallet (nobody can spend them). Nothing else is left to recover for this swap.";
    const r = applyView(
      record(),
      wire({
        state: 'failed',
        reason: 'settled-elsewhere',
        message,
        recoverable: false,
        settledElsewhere: [{ ...LOST_DEPOSIT, amount: '1040000' }],
      }),
      3,
    );
    expect(r).toMatchObject({ phase: 'failed', error: message, recoverable: false });
    expect(r.lost).toHaveLength(1);
  });

  it('the swap page says what was lost, with the sweep’s Sepolia link', () => {
    const r = record({ lost: [{ kind: 'deposit', colour: H('a'), amount: '1', evmTx: `0x${H('f')}` }] });
    const html = renderToStaticMarkup(<LostNotice record={r} network={STAGENET} />);
    expect(html).toContain('data-testid="lost-notice"');
    expect(html).toContain('0.000001 USDC');
    expect(html).toContain('bridged in by another party');
    expect(html).toContain(`https://sepolia.etherscan.io/tx/0x${H('f')}`);
    expect(html).toContain('The swap goes on with what is left.');
    const done = renderToStaticMarkup(<LostNotice record={{ ...r, phase: 'failed' }} network={STAGENET} />);
    expect(done).toContain('Nothing more can be recovered for it.');
    expect(renderToStaticMarkup(<LostNotice record={record()} network={STAGENET} />)).toBe('');
  });
});

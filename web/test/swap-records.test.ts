// The swap record in the browser store: its strict shape (no secret field fits), the store helpers,
// and Import accepting only swap records this page writes, filed under their own swap and wallet.

import { beforeEach, describe, expect, it } from 'vitest';

import { SwapRecordSchema, type SwapRecord } from '../src/swap/record-shape.js';
import { SwapRecordError, readSwapRecord, readSwapRecords, saveSwapRecord } from '../src/swap/records.js';
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, encodeRecord, recordKey } from '../src/store/schema.js';
import { ImportError, LocalStore } from '../src/store/store.js';
import { expectImportRoundTrip } from './roundtrip.js';

const H = (c: string) => c.repeat(64);
const ME = '0x484738A67858305Edfc139B194Ed430Fe4D8e56b';
const scope = { network: 'stagenet', evmAddress: ME };

function rec(id: string, createdAt: number, patch: Partial<SwapRecord> = {}): SwapRecord {
  return {
    v: 1,
    swapId: `0x${H(id)}`,
    derivation: 1,
    network: 'stagenet',
    vault: H('7'),
    evmAddress: ME,
    deterministic: true,
    offer: {
      offerId: H('9'),
      pay: { colour: H('a'), symbol: 'USDC', midnightName: 'wUSDC', decimals: 6, amount: '1040000' },
      receive: { colour: H('b'), symbol: 'stkA', midnightName: 'wStkA', decimals: 6, amount: '100000000' },
      expiresAt: '2026-10-11T12:00:00.000Z',
    },
    temp: { coinPk: H('c'), encPk: H('d'), shieldedAddress: 'mn_shield-addr_stagenet1x' },
    deposit: {
      address: '0xFA0D1f6448c87d7a5ab437492Ca5865D68C4f55F',
      erc20Address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      amount: '1040000',
      sweepGas: { gasLimit: '65000', maxFeePerGas: '2500000000', ethWei: '162500000000000' },
    },
    funding: { eth: { hash: `0x${H('e')}`, status: 'confirmed' } },
    bridgeIn: { requestId: H('1'), stages: [{ stage: 'starting', at: 5 }] },
    take: { tx: H('2'), landed: true, attempts: 1 },
    choice: 'swap',
    bridgeOut: { attempts: 1, earlier: [] },
    phase: 'bridging-out',
    createdAt,
    updatedAt: createdAt,
    ...patch,
  };
}

let store: LocalStore;
beforeEach(() => {
  localStorage.clear();
  store = new LocalStore(localStorage);
});

describe('the swap record', () => {
  it('has no room for a secret: a seed, a signature or the sponsor token is refused', () => {
    for (const secret of ['seed', 'seedHex', 'signature', 'swapToken', 'privateKey'])
      expect(SwapRecordSchema.safeParse({ ...rec('5', 1), [secret]: H('f') }).success, secret).toBe(false);
    expect(SwapRecordSchema.safeParse({ ...rec('5', 1), temp: { ...rec('5', 1).temp, seed: H('f') } }).success).toBe(
      false,
    );
    expect(() => saveSwapRecord(store, { ...rec('5', 1), seed: H('f') } as SwapRecord)).toThrow(SwapRecordError);
    expect(localStorage.length).toBe(0);
  });

  it('is filed under its wallet and swap, and read back newest first', () => {
    saveSwapRecord(store, rec('5', 1));
    saveSwapRecord(store, rec('6', 2));
    expect(localStorage.getItem(recordKey(scope, 'swap', { id: H('5') }))).not.toBeNull();
    expect(readSwapRecords(store, scope).map((r) => r.swapId)).toEqual([`0x${H('6')}`, `0x${H('5')}`]);
    expect(readSwapRecord(store, scope, `0x${H('5')}`)?.createdAt).toBe(1);
    // Another wallet sees none of them.
    expect(readSwapRecords(store, { network: 'stagenet', evmAddress: `0x${'11'.repeat(20)}` })).toEqual([]);
  });

  it('skips a stored record that is not in its shape', () => {
    saveSwapRecord(store, rec('5', 1));
    localStorage.setItem(recordKey(scope, 'swap', { id: H('6') }), encodeRecord('swap', { swapId: 'nonsense' }, 1));
    expect(readSwapRecords(store, scope)).toHaveLength(1);
  });

  it('survives Export → CLEAR ALL → Import unchanged', () => {
    saveSwapRecord(store, rec('5', 1));
    saveSwapRecord(store, rec('6', 2, { phase: 'done', outcome: 'bridged-back', choice: 'bridge-back' }));
    expectImportRoundTrip(store, scope);
  });
});

describe('Import of swap records', () => {
  const file = (records: Array<{ key: string; value: unknown }>) => ({
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    schemaVersion: 1,
    exportedAt: '2026-09-29T00:00:00Z',
    network: 'stagenet',
    evmAddress: ME.toLowerCase(),
    records,
  });
  const entry = (id: string, data: unknown) => ({
    key: recordKey(scope, 'swap', { id }),
    value: { v: 1, kind: 'swap', updatedAt: 1, data },
  });

  it('accepts a record the page writes', () => {
    expect(store.importWallet(file([entry(H('5'), rec('5', 1))]), scope).imported).toBe(1);
  });

  it('refuses a record with a secret in it, filed under another swap, or naming another wallet', () => {
    expect(() => store.importWallet(file([entry(H('5'), { ...rec('5', 1), seed: H('f') })]), scope)).toThrow(
      ImportError,
    );
    expect(() => store.importWallet(file([entry(H('6'), rec('5', 1))]), scope)).toThrow(/filed under another swap/);
    expect(() =>
      store.importWallet(file([entry(H('5'), { ...rec('5', 1), evmAddress: `0x${'22'.repeat(20)}` })]), scope),
    ).toThrow(/another wallet/);
    expect(localStorage.length).toBe(0);
  });
});

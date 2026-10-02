// Plan 00048 P4.2-fix5, row U4 (the audit's F-B53, Codex round 5): Done on arrival must bind the
// payout to THIS swap's own withdrawal. FW4's rule (a mined status-1 `Transfer` of the expected token
// from the vault's EVM account to the user, after the funding, not counted for another swap in this
// browser) still let another swap's payout count when the sponsor named its hash: same token, amount,
// vault and user (another browser's swap). Now the payout's transaction must also be from the vault's
// EVM account with a nonce that one of this swap's own withdrawals signed: the page supplied that
// nonce to `/prove` (`evmNonce`), and the record keeps it (`bridgeOut.evmNonces`).

import { STAGENET } from '@evm-midnight-transparent/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { boundToWithdrawal } from '../src/swap/arrival.js';
import { parseTransaction } from '../src/swap/evm.js';
import { announceMockEvmWallet } from '../src/swap/mock/evm-wallet.js';
import type { Eip1193Provider } from '../src/wallet/eip1193.js';
import type { MockScenario, MockEnvironment } from '../src/swap/mock/index.js';
import { type SwapRecord, SwapRecordSchema, isDoneForUser } from '../src/swap/record-shape.js';
import { saveSwapRecord } from '../src/swap/records.js';
import { type SessionDeps, type SessionStatus, SwapSession } from '../src/swap/session.js';
import { LocalStore } from '../src/store/store.js';
import { expectImportRoundTrip } from './roundtrip.js';
import { FakeSepolia, askOffer, backendsOf, mockEnv, network, registry, testSigner, waitFor } from './swap-fixtures.js';

const VAULT_EVM = STAGENET.bridge.vaultEvmAddress.toLowerCase();
const H = (c: string) => `0x${c.repeat(64).slice(0, 64)}`;

let env: MockEnvironment;
let store: LocalStore;
const sessions: SwapSession[] = [];

beforeEach(() => {
  localStorage.clear();
  store = new LocalStore(localStorage);
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  env?.stop();
});

const statusOf = (s: SwapSession) => s.getSnapshot().status;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sponsorSwap = () => [...env.sponsor.swaps.values()][0]!;
const attempts = () => {
  const sw = sponsorSwap();
  return sw ? [...(sw.earlier ?? []), ...(sw.view.withdraw ? [sw.view.withdraw] : [])] : [];
};
const transferOf = (n = 0) => waitFor(() => attempts()[n]?.sepoliaTx, 15_000, `transfer ${n + 1}`);

/** Every status the session showed (to tell whether Done was EVER shown). */
function watch(s: SwapSession) {
  const seen: SessionStatus[] = [];
  s.subscribe(() => {
    const st = s.getSnapshot().status;
    if (seen.at(-1) !== st) seen.push(st);
  });
  return { firstDone: () => seen.find((x) => x.kind === 'done') };
}

/** A funded swap of the mock book's ask offer; the bridge's transfers readable on the fake Sepolia
 *  (receipts AND transactions); each good withdrawal held once its transfer is mined. */
async function fundedSwap(scenario: MockScenario = {}) {
  env = mockEnv({ stepMs: 20, scenario: { holdAfterTransfer: true, ...scenario } });
  const offer = await askOffer(env);
  const signer = testSigner();
  const evm = new FakeSepolia(signer.address);
  evm.bridgeReceipts = (h) => env.controls.sepoliaReceipt(h);
  evm.bridgeTransactions = (h) => env.controls.sepoliaTransaction(h);
  env.setEvmReader(evm);
  const deps: SessionDeps = {
    backends: backendsOf(env),
    network,
    registry,
    signer,
    evm,
    save: (r) => saveSwapRecord(store, r),
  };
  const s = SwapSession.begin(offer, deps);
  sessions.push(s);
  const w = watch(s);
  await waitFor(() => statusOf(s).kind === 'fund', 5_000, 'the funding step');
  await s.sendFunds();
  return { s, evm, signer, offer, ...w };
}

describe('U4 (F-B53): Done on arrival only for a payout of THIS swap’s own withdrawal', { timeout: 40_000 }, () => {
  it('another withdrawal’s payout (right token, amount, vault and user, mined after the funding) is never Done', async () => {
    const { s, firstDone, evm } = await fundedSwap({ transferReceipt: 'foreign' });
    const tx = await transferOf();
    await sleep(500);
    expect(firstDone()).toBeUndefined();
    expect(s.getSnapshot().record!.arrivals).toBeUndefined();
    expect(evm.transactionReads).toContain(tx);
    await waitFor(
      () => /is not this swap's own withdrawal/.test(s.getSnapshot().notice ?? ''),
      5_000,
      'the not-counted notice',
    );
    // The sponsor still says `withdrawing` (held): the page follows it and shows no Done.
    expect(statusOf(s).kind).toBe('working');
  });

  it('this swap’s own payout (the nonce its withdrawal signed) is Done on arrival, and the record keeps that nonce', async () => {
    const { s, signer } = await fundedSwap();
    const tx = await transferOf();
    await waitFor(() => statusOf(s).kind === 'done', 10_000, 'Done on arrival');
    const r = s.getSnapshot().record!;
    expect(r.arrivals!.map((a) => a.tx)).toEqual([tx]);
    expect(r.bridgeOut.evmNonces).toEqual([sponsorSwap().attemptNonce]);
    expect(isDoneForUser(r)).toBe(true);
    // The nonces travel with the record (Export / Import → Resume).
    expectImportRoundTrip(store, { network: 'stagenet', evmAddress: signer.address });
  });

  it('a refunded withdrawal and its retry: each signed nonce is kept, and the retry’s payout is Done', async () => {
    const { s } = await fundedSwap({ refundFirstWithdrawal: true });
    const retry = await transferOf(1);
    await waitFor(() => statusOf(s).kind === 'done', 15_000, 'Done on arrival of the retry');
    const r = s.getSnapshot().record!;
    expect(r.bridgeOut.evmNonces).toHaveLength(2);
    expect(r.arrivals!.map((a) => a.tx)).toEqual([retry]);
  });
});

describe('U4 (F-B53): the binding, pure', () => {
  const tx = (o: { from?: string; nonce?: bigint } = {}) => ({
    hash: H('a'),
    from: o.from ?? VAULT_EVM,
    nonce: o.nonce ?? 9n,
  });
  it('binds a transaction from the vault’s EVM account with one of the swap’s own withdrawal nonces, nothing else', () => {
    expect(boundToWithdrawal(tx(), { from: VAULT_EVM }, ['9'])).toBe(true);
    expect(boundToWithdrawal(tx({ nonce: 10n }), { from: VAULT_EVM }, ['9', '10'])).toBe(true);
    expect(boundToWithdrawal(tx({ nonce: 10n }), { from: VAULT_EVM }, ['9'])).toBe(false);
    expect(boundToWithdrawal(tx({ from: `0x${'12'.repeat(20)}` }), { from: VAULT_EVM }, ['9'])).toBe(false);
    // A record written before P4.2-fix5 kept no nonce: never bound (only the sponsor's `done` ends it).
    expect(boundToWithdrawal(tx(), { from: VAULT_EVM }, undefined)).toBe(false);
    expect(boundToWithdrawal(tx(), { from: VAULT_EVM }, [])).toBe(false);
  });

  it('reads an eth_getTransactionByHash answer strictly (parseTransaction)', () => {
    const raw = { hash: H('a'), from: VAULT_EVM, nonce: '0x9', blockNumber: '0x5b8d81' };
    expect(parseTransaction(raw, H('a'))).toEqual({ hash: H('a'), from: VAULT_EVM, nonce: 9n });
    expect(parseTransaction({ ...raw, from: VAULT_EVM.toUpperCase().replace('0X', '0x') }, H('a'))!.from).toBe(
      VAULT_EVM,
    );
    // Pending (no block), another transaction, malformed fields, nothing: not a mined transaction.
    expect(parseTransaction({ ...raw, blockNumber: null }, H('a'))).toBeNull();
    expect(parseTransaction({ ...raw, hash: H('b') }, H('a'))).toBeNull();
    expect(parseTransaction({ ...raw, nonce: 'nine' }, H('a'))).toBeNull();
    expect(parseTransaction({ ...raw, from: 'nope' }, H('a'))).toBeNull();
    expect(parseTransaction(null, H('a'))).toBeNull();
  });

  it('the record format keeps the nonces as decimal strings, at most 16', () => {
    const base = (n: unknown) => ({ bridgeOut: { evmNonces: n } }) as unknown as Partial<SwapRecord>;
    const shape = SwapRecordSchema;
    // Only the bridgeOut block is checked here: a decimal list is accepted, anything else refused.
    const ok = (n: unknown) =>
      !shape.safeParse(base(n)).error?.issues.some((i) => i.path.join('.').startsWith('bridgeOut.evmNonces'));
    expect(ok(['9', '10'])).toBe(true);
    expect(ok(['0x9'])).toBe(false);
    expect(ok(Array.from({ length: 17 }, (_, i) => String(i)))).toBe(false);
  });
});

describe("U4: the mock-mode demo wallet answers the bridge's transactions", () => {
  it('returns the mock world transaction (the vault account and its nonce) for a bridge transfer, and its own', async () => {
    env = mockEnv();
    let provider: Eip1193Provider | null = null;
    const grab = (e: Event) => (provider = (e as CustomEvent<{ provider: Eip1193Provider }>).detail.provider);
    window.addEventListener('eip6963:announceProvider', grab);
    const { address } = announceMockEvmWallet(
      registry,
      window,
      (h) => env.controls.sepoliaReceipt(h),
      (h) => env.controls.sepoliaTransaction(h),
    );
    window.removeEventListener('eip6963:announceProvider', grab);
    const p = provider!;
    const own = (await p.request({
      method: 'eth_sendTransaction',
      params: [{ from: address, to: address, value: '0x1' }],
    })) as string;
    expect(parseTransaction(await p.request({ method: 'eth_getTransactionByHash', params: [own] }), own)).toEqual({
      hash: own.toLowerCase(),
      from: address.toLowerCase(),
      nonce: 0n,
    });
    const bridged = env.chain.mineSepoliaTransfer({
      token: registry.bySymbol('stkA')!.sepoliaAddress,
      from: VAULT_EVM,
      to: address,
      amount: '100000000',
      status: 1,
      nonce: '12',
    });
    const t = parseTransaction(await p.request({ method: 'eth_getTransactionByHash', params: [bridged] }), bridged)!;
    expect(t).toEqual({ hash: bridged, from: VAULT_EVM, nonce: 12n });
    expect(boundToWithdrawal(t, { from: VAULT_EVM }, ['12'])).toBe(true);
  });
});

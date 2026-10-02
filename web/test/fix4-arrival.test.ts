// Plan 00048 P4.2-fix4, lane FW4: Done on arrival. The owner's live swap: "Stuck on done, but I have
// the tokens in my EVM wallet (it worked)" (evidence/00048-evm-midnight-transparent/owner-test/
// owner-swap-1.md): the page said Done only after the bridge's ~17 minutes of closing. Now the swap is
// done for the user as soon as the payout's Sepolia transfer is mined with status 1 and carries the
// ERC20 `Transfer(vault's EVM account → the user, amount)` of the expected token, read from its
// receipt through the user's wallet (never on the sponsor's word alone); the loop keeps following the
// sponsor until it says `done`, and shows what contradicts the arrival. Never Done for a failed
// transfer, another token, another amount, an older transfer, or a partial Bridge back with a rest.

import { STAGENET } from '@evm-midnight-transparent/core';
import { id } from 'ethers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGREES_WITH_ARRIVAL,
  ERC20_TRANSFER_TOPIC,
  arrivalCandidates,
  checkTransfer,
  expectedArrival,
} from '../src/swap/arrival.js';
import { type MinedReceipt, evmPort, parseReceipt } from '../src/swap/evm.js';
import { announceMockEvmWallet } from '../src/swap/mock/evm-wallet.js';
import { stageStates } from '../src/swap/flow.js';
import type { MockEnvironment, MockScenario } from '../src/swap/mock/index.js';
import { type SwapRecord, arrivedAmount, arrivedInFull, isDoneForUser, isResumable } from '../src/swap/record-shape.js';
import { readSwapRecords, saveSwapRecord } from '../src/swap/records.js';
import { type SessionDeps, type SessionStatus, SwapSession } from '../src/swap/session.js';
import type { SwapView } from '../src/swap/sponsor-client.js';
import { LocalStore } from '../src/store/store.js';
import type { Eip1193Provider } from '../src/wallet/eip1193.js';
import { expectImportRoundTrip } from './roundtrip.js';
import { FakeSepolia, askOffer, backendsOf, mockEnv, network, registry, testSigner, waitFor } from './swap-fixtures.js';

const VAULT_EVM = STAGENET.bridge.vaultEvmAddress.toLowerCase();
const USER = '0x484738a67858305edfc139b194ed430fe4d8e56b';
const STKA = registry.bySymbol('stkA')!;
const USDC = registry.bySymbol('USDC')!;
const H = (c: string) => `0x${c.repeat(64).slice(0, 64)}`;
const word = (hex: string) => `0x${hex.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

/** A receipt as the page reads it: the transfer log of `token` from `from` to `to`, `value` units. */
function receipt(o: {
  hash?: string;
  status?: 'success' | 'reverted';
  block?: number;
  token?: string;
  from?: string;
  to?: string;
  value?: bigint;
  topic?: string;
  logs?: MinedReceipt['logs'];
}): MinedReceipt {
  return {
    hash: o.hash ?? H('a'),
    status: o.status ?? 'success',
    blockNumber: o.block ?? 6_000_001,
    logs: o.logs ?? [
      {
        address: (o.token ?? STKA.sepoliaAddress).toLowerCase(),
        topics: [o.topic ?? ERC20_TRANSFER_TOPIC, word(o.from ?? VAULT_EVM), word(o.to ?? USER)],
        data: word((o.value ?? 100_000_000n).toString(16)),
      },
    ],
  };
}

const expected = { token: STKA.sepoliaAddress.toLowerCase(), from: VAULT_EVM, to: USER };

describe('P4.2-fix4: what counts as the payout having arrived (pure)', () => {
  it("uses the ERC20 Transfer event's topic", () => {
    expect(ERC20_TRANSFER_TOPIC).toBe(id('Transfer(address,address,uint256)'));
  });

  it('counts a mined transfer of the expected token from the vault to the user, after the funding', () => {
    expect(checkTransfer(receipt({}), expected, 5_000_002)).toEqual({ kind: 'arrived', amount: 100_000_000n });
    // Two matching logs in one transaction add up.
    const one = receipt({}).logs[0]!;
    expect(checkTransfer(receipt({ logs: [one, one] }), expected, 5_000_002)).toEqual({
      kind: 'arrived',
      amount: 200_000_000n,
    });
  });

  it('never counts a failed receipt, another token, sender, recipient or event, or nothing moved', () => {
    expect(checkTransfer(receipt({ status: 'reverted' }), expected, 1)).toEqual({ kind: 'reverted' });
    for (const bad of [
      receipt({ token: USDC.sepoliaAddress }),
      receipt({ from: USER }),
      receipt({ to: VAULT_EVM }),
      receipt({ topic: id('Approval(address,address,uint256)') }),
      receipt({ value: 0n }),
      receipt({ logs: [] }),
    ])
      expect(checkTransfer(bad, expected, 1)).toEqual({ kind: 'no-transfer' });
  });

  it('never counts a transfer mined before (or in the block of) the user funding this swap, or with no funding block', () => {
    expect(checkTransfer(receipt({ block: 5_000_000 }), expected, 5_000_002)).toEqual({ kind: 'too-early' });
    expect(checkTransfer(receipt({ block: 5_000_002 }), expected, 5_000_002)).toEqual({ kind: 'too-early' });
    expect(checkTransfer(receipt({}), expected, null)).toEqual({ kind: 'too-early' });
  });

  it('reads an eth_getTransactionReceipt answer strictly (parseReceipt)', () => {
    const raw = {
      transactionHash: H('a'),
      status: '0x1',
      blockNumber: '0x5b8d81',
      logs: [
        { address: STKA.sepoliaAddress, topics: [ERC20_TRANSFER_TOPIC, word(VAULT_EVM), word(USER)], data: word('5') },
        { address: 'nope', topics: [], data: '0x' },
        { address: STKA.sepoliaAddress, topics: ['0x12'], data: '0x' },
        { address: STKA.sepoliaAddress, topics: [ERC20_TRANSFER_TOPIC], data: '0x', removed: true },
      ],
    };
    const r = parseReceipt(raw, H('a'))!;
    expect(r).toMatchObject({ hash: H('a'), status: 'success', blockNumber: 6_000_001 });
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]!.address).toBe(STKA.sepoliaAddress.toLowerCase());
    expect(parseReceipt({ ...raw, status: '0x0' }, H('a'))!.status).toBe('reverted');
    expect(parseReceipt(null, H('a'))).toBeNull();
    expect(parseReceipt({ ...raw, transactionHash: H('b') }, H('a'))).toBeNull();
    expect(parseReceipt({ ...raw, status: undefined }, H('a'))).toBeNull();
    expect(parseReceipt({ ...raw, blockNumber: null }, H('a'))).toBeNull();
  });

  it('the real port reads the receipt on Sepolia only (never another network)', async () => {
    const calls: string[] = [];
    let chainId = '0xaa36a7';
    const provider: Eip1193Provider = {
      async request({ method }) {
        calls.push(method);
        if (method === 'eth_chainId') return chainId;
        if (method === 'eth_accounts') return [USER];
        if (method === 'eth_getTransactionReceipt')
          return { transactionHash: H('a'), status: '0x1', blockNumber: '0x10', logs: [] };
        throw new Error(method);
      },
    };
    const port = evmPort(provider, USER, { chainIdHex: '0xaa36a7', chainName: 'Sepolia' });
    await expect(port.minedReceipt(H('a'))).resolves.toMatchObject({ status: 'success', blockNumber: 16 });
    chainId = '0x1';
    await expect(port.minedReceipt(H('a'))).rejects.toThrow(/not on Sepolia/);
    expect(calls.filter((c) => c === 'eth_getTransactionReceipt')).toHaveLength(1);
    await expect(port.minedReceipt('0x12')).resolves.toBeNull();
  });
});

// ── the session, against the mock sponsor and the mock world's fake Sepolia ──────────────────────

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
const sponsorView = () => env.sponsor.views()[0]!;
const sponsorSwap = () => [...env.sponsor.swaps.values()][0]!;
const withdrawParamsCalls = () => env.sponsor.requests.filter((q) => q.path.endsWith('/withdraw-params')).length;

/** What the record's arrivals add up to, and whether that is the whole payout: computed here, not
 *  with the page's own helpers, so the watch works on any version of the page (the fails-before run). */
const arrivedOf = (r: SwapRecord | null) => (r?.arrivals ?? []).reduce((n, a) => n + BigInt(a.amount), 0n);
const wholeOf = (r: SwapRecord) => BigInt(r.choice === 'bridge-back' ? r.offer.pay.amount : r.offer.receive.amount);

/** Every status the session showed, with the record and the sponsor's state at that moment. */
function watch(s: SwapSession) {
  const seen: Array<{ status: SessionStatus; arrived: bigint; full: boolean; sponsor: string | undefined }> = [];
  s.subscribe(() => {
    const snap = s.getSnapshot();
    const last = seen.at(-1);
    if (last && last.status === snap.status) return;
    seen.push({
      status: snap.status,
      arrived: arrivedOf(snap.record),
      full: !!snap.record && arrivedOf(snap.record) === wholeOf(snap.record),
      sponsor: env.sponsor.views()[0]?.state,
    });
  });
  return { seen, firstDone: () => seen.find((x) => x.status.kind === 'done') };
}

/** A swap of the mock book's "pay 1.04 USDC, receive 100 stkA" offer, funded, with the bridge's
 *  transfers readable on the fake Sepolia; the mock holds each good withdrawal once its transfer is
 *  mined (the bridge's closing, held), unless the scenario says otherwise. */
async function fundedSwap(scenario: MockScenario = {}, extra: Partial<SessionDeps> = {}) {
  env = mockEnv({ stepMs: 20, scenario: { holdAfterTransfer: true, ...scenario } });
  const offer = await askOffer(env);
  const signer = testSigner();
  const evm = new FakeSepolia(signer.address);
  evm.bridgeReceipts = (h) => env.controls.sepoliaReceipt(h);
  // P4.2-fix5 U4: the payout's transaction (its vault-account nonce) is read too.
  evm.bridgeTransactions = (h) => env.controls.sepoliaTransaction(h);
  env.setEvmReader(evm);
  const deps: SessionDeps = {
    backends: backendsOf(env),
    network,
    registry,
    signer,
    evm,
    save: (r) => saveSwapRecord(store, r),
    ...extra,
  };
  const s = SwapSession.begin(offer, deps);
  sessions.push(s);
  const w = watch(s);
  await waitFor(() => statusOf(s).kind === 'fund', 5_000, 'the funding step');
  await s.sendFunds();
  return { s, evm, signer, offer, ...w };
}

/** The mock sponsor's withdrawals of the swap, every attempt, oldest first. */
const attempts = () => {
  const sw = sponsorSwap();
  return sw ? [...(sw.earlier ?? []), ...(sw.view.withdraw ? [sw.view.withdraw] : [])] : [];
};
/** The Sepolia transfer of the swap's `n`-th withdrawal, once the bridge reports it. */
const transferOf = (n = 0) => waitFor(() => attempts()[n]?.sepoliaTx, 15_000, `transfer ${n + 1}`);

describe('P4.2-fix4: Done on arrival, in the session', { timeout: 40_000 }, () => {
  it('shows Done as soon as the transfer to the user is mined and verified; the bridge closes in the background', async () => {
    const { s, evm, signer, offer } = await fundedSwap();
    const tx = await transferOf();
    await waitFor(() => statusOf(s).kind === 'done', 10_000, 'Done on arrival');
    // The sponsor has NOT closed the request: it still says `withdrawing` (held).
    expect(sponsorView().state).toBe('withdrawing');
    expect(statusOf(s)).toEqual({ kind: 'done', closing: true });
    const r = s.getSnapshot().record!;
    expect(r.phase).toBe('bridging-out');
    expect(r.arrivals).toEqual([
      {
        tx,
        colour: offer.receive.token.midnightColour,
        amount: offer.receive.amount.toString(),
        at: expect.any(Number),
      },
    ]);
    expect(evm.receiptReads).toContain(tx);
    expect(isDoneForUser(r)).toBe(true);
    expect(Object.values(stageStates(r))).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    // Your swaps reads the stored record: done for the user, nothing to resume.
    const [stored] = readSwapRecords(store, { network: 'stagenet', evmAddress: signer.address });
    expect(isDoneForUser(stored!)).toBe(true);
    expect(isResumable(stored!)).toBe(false);

    // Background tracking continues while the bridge closes the request, and acts on nothing.
    const polls = env.sponsor.requests.length;
    const params = withdrawParamsCalls();
    await sleep(200);
    expect(env.sponsor.requests.length).toBeGreaterThan(polls + 5);
    expect(withdrawParamsCalls()).toBe(params);
    expect(statusOf(s)).toEqual({ kind: 'done', closing: true });

    // The bridge closes the request: the sponsor's `done`, the quiet note gone.
    env.controls.setScenario({ holdAfterTransfer: false });
    await waitFor(() => s.getSnapshot().record!.phase === 'done', 10_000, "the sponsor's done");
    await waitFor(() => statusOf(s).kind === 'done' && !('closing' in statusOf(s)), 5_000, 'the final Done');
    expect(s.getSnapshot().record!.outcome).toBe('swapped');
    expectImportRoundTrip(store, { network: 'stagenet', evmAddress: signer.address });
  });

  it('is NOT shown for a failed (reverted) transfer: the page says so, the bridge refunds, the retry arrives, then Done', async () => {
    const { s, firstDone, offer } = await fundedSwap({ transferReceipt: 'reverted' });
    const failed = await transferOf(0);
    await waitFor(() => /failed on Sepolia/.test(s.getSnapshot().notice ?? ''), 10_000, 'the failed-transfer notice');
    const retry = await transferOf(1);
    await waitFor(() => statusOf(s).kind === 'done', 15_000, 'Done on arrival of the retry');
    // Done appeared only with the retry's verified transfer, while the bridge still closes it.
    expect(firstDone()).toMatchObject({ full: true, sponsor: 'withdrawing', arrived: offer.receive.amount });
    const r = s.getSnapshot().record!;
    expect(r.arrivals!.map((a) => a.tx)).toEqual([retry]);
    expect(r.arrivals!.map((a) => a.tx)).not.toContain(failed);
  });

  it('is NOT shown for a transfer of another token: the page says it does not count it', async () => {
    const { s, firstDone } = await fundedSwap({ transferReceipt: 'wrong-token' });
    await transferOf();
    await waitFor(
      () => /does not carry the transfer of stkA/.test(s.getSnapshot().notice ?? ''),
      10_000,
      'the not-counted notice',
    );
    await sleep(200);
    expect(firstDone()).toBeUndefined();
    expect(s.getSnapshot().record!.arrivals).toBeUndefined();
    expect(sponsorView().state).toBe('withdrawing');
  });

  it('is NOT shown for another amount: what arrived is shown as part of the whole, not Done', async () => {
    const { s, firstDone, offer } = await fundedSwap({ transferReceipt: 'wrong-amount' });
    await transferOf();
    await waitFor(() => s.getSnapshot().record!.arrivals?.length === 1, 10_000, 'the arrival read');
    await sleep(200);
    const r = s.getSnapshot().record!;
    expect(arrivedAmount(r)).toBe(offer.receive.amount - 1n);
    expect(arrivedInFull(r)).toBe(false);
    expect(isDoneForUser(r)).toBe(false);
    expect(firstDone()).toBeUndefined();
    expect(statusOf(s).kind).toBe('working');
  });

  it('is NOT shown for a transfer mined before the user funded this swap (not this swap’s)', async () => {
    const { s, firstDone } = await fundedSwap({ transferReceipt: 'older' });
    await transferOf();
    await waitFor(() => /mined before you funded this swap/.test(s.getSnapshot().notice ?? ''), 10_000, 'the notice');
    await sleep(200);
    expect(firstDone()).toBeUndefined();
    expect(s.getSnapshot().record!.arrivals).toBeUndefined();
  });

  it('is NOT shown for a transfer already counted for another swap in this browser', async () => {
    // Another record of this wallet already counts every transfer this swap's sponsor reports.
    const claimed = () => new Set(attempts().flatMap((w) => (w.sepoliaTx ? [w.sepoliaTx] : [])));
    const { s, firstDone } = await fundedSwap({}, { claimedArrivals: claimed });
    await transferOf();
    await waitFor(() => /already counted for another/.test(s.getSnapshot().notice ?? ''), 10_000, 'the notice');
    await sleep(200);
    expect(firstDone()).toBeUndefined();
    expect(s.getSnapshot().record!.arrivals).toBeUndefined();
  });

  it('reads nothing while the wallet is off Sepolia, then shows Done once it is back', async () => {
    const { s, evm } = await fundedSwap();
    evm.chainId = '0x1';
    await transferOf();
    await sleep(200);
    expect(statusOf(s).kind).not.toBe('done');
    expect(s.getSnapshot().record!.arrivals).toBeUndefined();
    evm.chainId = '0xaa36a7';
    await waitFor(() => statusOf(s).kind === 'done', 10_000, 'Done on arrival');
  });

  it('shows a later contradiction from the sponsor, sends nothing more, and clears when the sponsor agrees again', async () => {
    const { s } = await fundedSwap();
    await transferOf();
    await waitFor(() => statusOf(s).kind === 'done', 10_000, 'Done on arrival');
    const params = withdrawParamsCalls();
    // The sponsor now says the withdrawal was refunded (it should not, after a verified transfer).
    const sw = sponsorSwap();
    sw.view.state = 'minted';
    sw.lastEnding = 'refunded';
    sw.script = null;
    await waitFor(() => (statusOf(s) as { conflict?: string }).conflict, 5_000, 'the conflict');
    expect(statusOf(s)).toMatchObject({
      kind: 'done',
      closing: true,
      conflict: expect.stringMatching(
        /arrived at your address on Sepolia .* holding the tokens in the temporary wallet again/,
      ),
    });
    await sleep(200);
    expect(withdrawParamsCalls()).toBe(params);
    // The tokens did arrive (verified): still done for the user, with the bridge's report shown.
    expect(isDoneForUser(s.getSnapshot().record!)).toBe(true);
    // The sponsor agrees again: the conflict clears.
    sw.view.state = 'withdrawing';
    sw.lastEnding = null;
    sw.script = 'withdraw';
    await waitFor(
      () => statusOf(s).kind === 'done' && !(statusOf(s) as { conflict?: string }).conflict,
      5_000,
      'clear',
    );
    expect(statusOf(s)).toEqual({ kind: 'done', closing: true });
  });

  it('drops an arrival whose receipt no longer reads as one (a reorganisation), and follows the sponsor again', async () => {
    const { s, evm, offer } = await fundedSwap();
    const tx = await transferOf();
    await waitFor(() => statusOf(s).kind === 'done', 10_000, 'Done on arrival');
    const coinPk = s.getSnapshot().record!.temp.coinPk;
    // The transfer is gone from the chain as it was (reverted now), and the bridge refunded.
    evm.receiptOverride.set(tx, { transactionHash: tx, status: '0x0', blockNumber: '0x5b8d90', logs: [] });
    const sw = sponsorSwap();
    env.chain.mint(coinPk, offer.receive.token.midnightColour, offer.receive.amount);
    sw.view.state = 'minted';
    sw.lastEnding = 'refunded';
    sw.script = null;
    await waitFor(() => /no longer reads as it did/.test(s.getSnapshot().notice ?? ''), 5_000, 'the drop');
    // The page rebuilds the withdrawal, whose new transfer arrives: Done again.
    const again = await transferOf(1);
    await waitFor(() => s.getSnapshot().record!.arrivals?.[0]?.tx === again, 15_000, 'the new arrival');
    await waitFor(() => statusOf(s).kind === 'done', 5_000, 'Done on the new arrival');
    expect(s.getSnapshot().record!.arrivals!.map((a) => a.tx)).toEqual([again]);
  });
});

describe('P4.2-fix4: a partial Bridge back is Done only when everything came back', { timeout: 60_000 }, () => {
  /** Fund the swap, then turn its deposit partial (another party's request swept `units`), and
   *  choose Bridge back (as fix3-partial.test.ts does it). */
  async function partialBack(units: bigint) {
    env = mockEnv({ stepMs: 25, scenario: { holdAfterTransfer: true } });
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    evm.bridgeReceipts = (h) => env.controls.sepoliaReceipt(h);
    evm.bridgeTransactions = (h) => env.controls.sepoliaTransaction(h);
    env.setEvmReader(evm);
    const s = SwapSession.begin(offer, {
      backends: backendsOf(env),
      network,
      registry,
      signer,
      evm,
      save: (r) => saveSwapRecord(store, r),
    });
    sessions.push(s);
    const w = watch(s);
    await waitFor(() => statusOf(s).kind === 'fund', 5_000, 'the funding step');
    env.setEvmReader({ ethBalance: async () => 0n, erc20Balance: async () => 0n });
    await s.sendFunds();
    await waitFor(() => s.getSnapshot().record!.funding.token?.status === 'confirmed', 5_000, 'the receipts');
    const r0 = s.getSnapshot().record!;
    const amount = BigInt(r0.offer.pay.amount);
    evm.erc20.set(`${r0.deposit.erc20Address.toLowerCase()}:${r0.deposit.address.toLowerCase()}`, amount - units);
    evm.eth.set(r0.deposit.address.toLowerCase(), 0n);
    env.controls.partialSweep(units.toString());
    env.setEvmReader(evm);
    await waitFor(() => statusOf(s).kind === 'partial', 5_000, 'the partial-deposit choice');
    s.bridgeBack();
    return { s, evm, amount, ...w };
  }

  it('the first part arrived: shown as part, never Done; the rest arrives: Done on arrival', async () => {
    const units = 40_000n;
    const { s, amount, firstDone } = await partialBack(units);
    const first = await transferOf(0);
    await waitFor(() => s.getSnapshot().record!.arrivals?.length === 1, 10_000, 'the first part read');
    await sleep(200);
    let r: SwapRecord = s.getSnapshot().record!;
    expect(r.arrivals!.map((a) => [a.tx, a.amount])).toEqual([[first, units.toString()]]);
    expect(arrivedAmount(r)).toBe(units);
    expect(arrivedInFull(r)).toBe(false);
    expect(isDoneForUser(r)).toBe(false);
    expect(firstDone()).toBeUndefined();
    expect(sponsorView().state).toBe('bridging_back');

    // The bridge closes the first part; the rest waits at the deposit address: the sponsor goes back to
    // `partial` (not done), and the page tops up the sweep ETH for it (never the token).
    env.controls.setScenario({ holdAfterTransfer: false });
    await waitFor(() => sponsorView().withdraw?.stage !== 'evm-broadcast', 5_000, 'the first part closing');
    env.controls.setScenario({ holdAfterTransfer: true });
    await waitFor(() => statusOf(s).kind === 'fund', 15_000, 'the sweep ETH top-up for the rest');
    expect(firstDone()).toBeUndefined();
    await s.sendFunds();

    // The rest is bridged in and back: its transfer completes the whole pay amount: Done on arrival.
    const second = await transferOf(1);
    await waitFor(() => statusOf(s).kind === 'done', 15_000, 'Done on arrival of the rest');
    r = s.getSnapshot().record!;
    expect(r.arrivals!.map((a) => a.tx)).toEqual([first, second]);
    expect(arrivedAmount(r)).toBe(amount);
    expect(firstDone()).toMatchObject({ full: true, sponsor: 'bridging_back', arrived: amount });
    expect(statusOf(s)).toEqual({ kind: 'done', closing: true });

    env.controls.setScenario({ holdAfterTransfer: false });
    await waitFor(() => s.getSnapshot().record!.phase === 'done', 10_000, "the sponsor's done");
    expect(s.getSnapshot().record!.outcome).toBe('bridged-back');
  });
});

describe('P4.2-fix4: the record and the flow decisions', () => {
  const view = (o: Partial<SwapView>): SwapView => ({ swapId: H('1'), state: 'withdrawing', ...o });

  it('reads the payout leg and its token from the record and the registry, never from the sponsor', () => {
    const rec = {
      choice: 'swap' as const,
      evmAddress: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
      offer: {
        offerId: 'a'.repeat(64),
        pay: { colour: USDC.midnightColour, symbol: 'USDC', midnightName: 'wUSDC', decimals: 6, amount: '1040000' },
        receive: { colour: STKA.midnightColour, symbol: 'stkA', midnightName: 'wStkA', decimals: 6, amount: '100' },
        expiresAt: null,
      },
    };
    expect(expectedArrival(rec, network, registry)).toEqual({
      token: STKA.sepoliaAddress.toLowerCase(),
      from: VAULT_EVM,
      to: USER,
      colour: STKA.midnightColour,
      total: 100n,
    });
    expect(expectedArrival({ ...rec, choice: 'bridge-back' }, network, registry)).toMatchObject({
      token: USDC.sepoliaAddress.toLowerCase(),
      total: 1_040_000n,
    });
    // No vault EVM account configured: no Done on arrival (only the sponsor's done).
    expect(expectedArrival(rec, { bridge: { ...network.bridge, vaultEvmAddress: '' } }, registry)).toBeNull();
  });

  it('collects every reported transfer hash once, and skips the verified ones', () => {
    const record = {
      arrivals: [{ tx: H('c'), colour: STKA.midnightColour, amount: '1', at: 1 }],
      bridgeOut: { sepoliaTx: H('d'), earlier: [{ sepoliaTx: H('e') }, { sepoliaTx: 'junk' }] },
    } as unknown as SwapRecord;
    const v = view({ withdraw: { sepoliaTx: H('d') }, withdrawals: [{ sepoliaTx: H('b') }, { sepoliaTx: H('c') }] });
    expect(arrivalCandidates(record, v)).toEqual([H('b'), H('d'), H('e')]);
    expect(arrivalCandidates(record, null)).toEqual([H('e'), H('d')]);
  });

  it('the states that agree with an arrival are the closing ones and done', () => {
    expect([...AGREES_WITH_ARRIVAL].sort()).toEqual(['bridging_back', 'done', 'withdrawing']);
  });
});

describe("P4.2-fix4: the mock-mode demo wallet answers the bridge's receipts", () => {
  it('returns the mock world receipt for a bridge transfer, and its own transactions mined below it', async () => {
    env = mockEnv();
    let provider: Eip1193Provider | null = null;
    const grab = (e: Event) => (provider = (e as CustomEvent<{ provider: Eip1193Provider }>).detail.provider);
    window.addEventListener('eip6963:announceProvider', grab);
    const { address } = announceMockEvmWallet(registry, window, (h) => env.controls.sepoliaReceipt(h));
    window.removeEventListener('eip6963:announceProvider', grab);
    const p = provider!;
    const own = (await p.request({
      method: 'eth_sendTransaction',
      params: [{ from: address, to: address, value: '0x1' }],
    })) as string;
    const ownReceipt = parseReceipt(await p.request({ method: 'eth_getTransactionReceipt', params: [own] }), own)!;
    expect(ownReceipt).toMatchObject({ status: 'success', blockNumber: 5_000_001, logs: [] });
    const bridged = env.chain.mineSepoliaTransfer({
      token: STKA.sepoliaAddress,
      from: VAULT_EVM,
      to: address,
      amount: '100000000',
      status: 1,
    });
    const r = parseReceipt(await p.request({ method: 'eth_getTransactionReceipt', params: [bridged] }), bridged)!;
    expect(r.blockNumber).toBeGreaterThan(ownReceipt.blockNumber);
    expect(checkTransfer(r, { ...expected, to: address.toLowerCase() }, ownReceipt.blockNumber)).toEqual({
      kind: 'arrived',
      amount: 100_000_000n,
    });
  });
});

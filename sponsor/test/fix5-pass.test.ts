// The P4.2 round-5 fix pass, sponsor side (plan 00048 P4.2-fix5; audit
// audits/00048-evm-midnight-transparent-security.md, "Consolidation, round 5" rows U1, U2, U3 and U5).
// Each describe block names its row; each test failed before its fix. They start from the round-5
// findings: Codex's F-B51 (U1) and F-B52 (U2), and auditor A's probes R5-T1-own (U3) and
// R5-view-cap (U5) (evidence/00048-evm-midnight-transparent/p4-audit/probes-a5/).

import { SETTLED_ELSEWHERE_REASON, SWAP_PATHS, SwapViewSchema, type SwapView } from '@evm-midnight-transparent/core';
import { Wallet } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';

import { jsonRpcEvmReader, parseTransaction } from '../src/bridge/evm.js';
import { applyView } from '../../web/src/swap/flow.js';
import { isResumable, type SwapRecord as WebRecord } from '../../web/src/swap/record-shape.js';
import { lostRecord } from '../../web/src/swap/settled-elsewhere.js';
import { SwapViewSchema as WebSwapViewSchema } from '../../web/src/swap/sponsor-client.js';
import { VAULT_EVM, gate } from './fakes.js';
import {
  BID,
  bidSwap,
  fund,
  get,
  harness,
  hex32,
  mintedSwap,
  openSwap,
  post,
  takeBody,
  testConfig,
  tok,
  txHex,
  withdrawFor,
  type Harness,
  type SwapInput,
} from './harness.js';

const GWEI = 1_000_000_000n;
const MIN = 60_000;
const DAY = 86_400_000;
const tick = () => new Promise((r) => setTimeout(r, 20));

const LIMITS = {
  RATE_LIMIT_PROVES_PER_SWAP_PER_MIN: '1000',
  RATE_LIMIT_PROVES_PER_MIN: '1000',
  RATE_LIMIT_WRITES_PER_MIN: '100000',
  RATE_LIMIT_OPENS_PER_MIN: '100000',
  RATE_LIMIT_NONCES_PER_MIN: '100000',
  RATE_LIMIT_READS_PER_MIN: '100000',
};

const view = async (h: Harness, s: SwapInput, token: string): Promise<SwapView> => {
  const body = (await (await get(h, SWAP_PATHS.swap(s.swapId), token)).json()) as { swap: unknown };
  return SwapViewSchema.parse(body.swap);
};

const proveWithdraw = (
  h: Harness,
  s: SwapInput,
  token: string,
  w: { tx: Parameters<typeof txHex>[0]; coinNonce: string; evmNonce: bigint },
) =>
  post(
    h,
    SWAP_PATHS.prove(s.swapId),
    { purpose: 'withdraw', tx: txHex(w.tx), coinNonce: w.coinNonce, evmNonce: w.evmNonce.toString() },
    token,
  );

async function takenSwap(hh: Harness, s: SwapInput = bidSwap(hh)) {
  const m = await mintedSwap(hh, s);
  expect((await post(hh, SWAP_PATHS.prove(s.swapId), takeBody(s), m.token)).status).toBe(200);
  expect((await post(hh, SWAP_PATHS.take(s.swapId), { outcome: 'taken', takeTx: hex32('take') }, m.token)).status).toBe(
    200,
  );
  return m;
}

function vaultReady(hh: Harness) {
  hh.vault.evm.nonces.set(VAULT_EVM.toLowerCase(), { latest: 9n, pending: 9n });
  hh.vault.evm.setEth(VAULT_EVM, 10n ** 17n);
  for (const t of [tok('stkA'), tok('USDC')]) hh.vault.evm.setErc20(t.sepoliaAddress, VAULT_EVM, 10n ** 12n);
}

/** The stale closer for 3 hours (auditor A's probe loop), with the deposit polls in between. */
async function closerFor3h(hh: Harness): Promise<number> {
  let redrives = 0;
  for (let i = 0; i < 6; i++) {
    hh.now.ms += 30 * MIN;
    for (const r of hh.swaps.stalled(Math.floor(hh.now.ms / 1000) - 600)) if (hh.swaps.redrive(r)) redrives++;
    await hh.swaps.idle();
    await hh.swaps.adoptLateStarts();
    await hh.swaps.idle();
    await hh.swaps.pollDeposits();
    await hh.swaps.idle();
  }
  return redrives;
}

const passes = async (hh: Harness, n: number, stepMs = 3 * MIN) => {
  for (let i = 0; i < n; i++) {
    hh.now.ms += stepMs;
    await hh.swaps.pollDeposits();
    await hh.swaps.idle();
  }
};

const settlesOf = (hh: Harness, circuit: string, requestId?: string) =>
  hh.vault.settles.filter((x) => x.circuit === circuit && (requestId === undefined || x.requestId === requestId))
    .length;

/** A request for the swap's recipient (anyone may post one: `startDeposit` is permissionless). */
const foreignDeposit = (
  hh: Harness,
  s: SwapInput,
  erc20: string,
  amount: bigint,
  evmNonce: bigint,
  gas: { gasLimit?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = {},
) =>
  hh.vault.startDeposit({
    recipientCoinPk: s.payload.tempCoinPk,
    erc20,
    amount,
    evmNonce,
    gas: {
      gasLimit: gas.gasLimit ?? 65_000n,
      maxFeePerGas: gas.maxFeePerGas ?? 3n * GWEI,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas ?? 2n * GWEI,
      keyVersion: 1n,
    },
  });

/** A funded swap whose own deposit request is held right before its attestation. */
async function depositHeldAtAttestation(hh: Harness, tag: string) {
  const s = bidSwap(hh, Wallet.createRandom(), tag);
  const o = await openSwap(hh, s);
  fund(hh, o);
  const hold = gate();
  hh.vault.defaultRelay = { kind: 'success', beforeAttest: hold.promise };
  await hh.swaps.pollDeposits();
  await tick();
  const requestId = hh.store.get(s.swapId)!.deposit!.requestId!;
  expect(requestId).toBeTruthy();
  return { s, o, hold, requestId };
}

async function withdrawHeldAtAttestation(hh: Harness, tag: string, kind: 'success' | 'never-executed') {
  const m = await takenSwap(hh, bidSwap(hh, Wallet.createRandom(), tag));
  const w = withdrawFor(hh, m.s, 'swap', { coinNonce: hex32(tag) });
  expect((await proveWithdraw(hh, m.s, m.token, w)).status).toBe(200);
  const hold = gate();
  hh.vault.defaultRelay = { kind, beforeAttest: hold.promise };
  expect((await post(hh, SWAP_PATHS.withdraw(m.s.swapId), { tx: txHex(w.tx) }, m.token)).status).toBe(202);
  await tick();
  await tick();
  const requestId = hh.store.get(m.s.swapId)!.withdrawals.at(-1)!.requestId!;
  expect(hh.vault.requests.has(requestId)).toBe(true);
  return { ...m, hold, requestId };
}

/** The transaction index of a replica behind its head: the indexer's head is fresh, but the lookup
 *  by identifier misses the sponsor's own settle (auditor A's R5-T1-own, replica) until `caughtUp`. */
function laggingIndex(hh: Harness) {
  const realFind = hh.vault.findTransaction.bind(hh.vault);
  const state = { caughtUp: false };
  hh.vault.findTransaction = async (id) => {
    const t = await realFind(id);
    return state.caughtUp ? t : { ...t, found: null };
  };
  return state;
}

/** The page's record of swap `s` while it bridges in (auditor A's probe helper, R5). */
function webRecord(s: SwapInput): WebRecord {
  return {
    v: 2,
    swapId: `0x${s.swapId}`,
    salt: `0x${s.swapId}`,
    derivation: 1,
    network: 'stagenet',
    vault: '77'.repeat(32),
    evmAddress: s.user.address,
    deterministic: true,
    offer: {
      offerId: BID.offerId,
      pay: {
        colour: BID.pay.token.midnightColour,
        symbol: 'stkA',
        midnightName: 'wStkA',
        decimals: 6,
        amount: BID.pay.amount.toString(),
      },
      receive: {
        colour: BID.receive.token.midnightColour,
        symbol: 'USDC',
        midnightName: 'wUSDC',
        decimals: 6,
        amount: BID.receive.amount.toString(),
      },
      expiresAt: null,
    },
    temp: { coinPk: s.payload.tempCoinPk, encPk: s.payload.tempEncPk, shieldedAddress: 'x' },
    deposit: {
      address: `0x${'1'.repeat(40)}`,
      erc20Address: `0x${'2'.repeat(40)}`,
      amount: '1',
      sweepGas: { gasLimit: '1', maxFeePerGas: '1', ethWei: '1' },
    },
    funding: {},
    bridgeIn: {},
    take: {},
    choice: 'swap',
    bridgeOut: { attempts: 0 },
    phase: 'bridging-in',
    createdAt: 1,
    updatedAt: 1,
  } as unknown as WebRecord;
}

let h: Harness;
beforeEach(() => {
  h = harness({ config: testConfig(LIMITS) });
  vaultReady(h);
});

// ── U1 (F-B51): a deferred foreign-completion resolution is scheduled again ────

/**
 * Codex's F-B51 set-up: the deposit address already shows a foreign 1-unit sweep (the drop was read
 * while its request was not attested yet), then the request is attested and the sponsor sends its
 * completion; `meddle` decides what happens to that completion (another party settles first, or the
 * sponsor's own lands with its answer lost) and makes the immediate resolution fail for a moment.
 */
async function deferredForeignCompletion(
  hh: Harness,
  tag: string,
  meddle: (requestId: string) => { restore: () => void },
) {
  const s = bidSwap(hh, Wallet.createRandom(), tag);
  const o = await openSwap(hh, s);
  fund(hh, o);
  // The sponsor's own sweep loses the deposit address's nonce to a 1-unit request of anyone's.
  const hold = gate();
  hh.vault.defaultRelay = { kind: 'never-executed', beforeBroadcast: hold.promise };
  await hh.swaps.pollDeposits();
  await tick();
  const f = await foreignDeposit(hh, s, o.erc20Address, 1n, 0n);
  hh.vault.sweep(f.requestId);
  hold.open();
  await hh.swaps.idle();
  hh.vault.defaultRelay = {};
  // The drop is read (its request is not attested yet: nothing to complete), then it is attested.
  hh.now.ms += MIN;
  await hh.swaps.pollDeposits();
  await hh.swaps.idle();
  expect(hh.store.get(s.swapId)!.deposit!.atAddress).toBe((BigInt(o.amount) - 1n).toString());
  hh.vault.attestations.set(f.requestId, 'success');
  hh.vault.sweepsMove = true;
  const m = meddle(f.requestId);
  // The reconciliation completes it; the resolution right after cannot decide.
  await passes(hh, 1);
  const entry = hh.store.get(s.swapId)!.deposit!.foreign?.find((x) => x.requestId === f.requestId);
  expect(entry?.status).toBe('completing');
  expect(hh.vault.requests.has(f.requestId)).toBe(false);
  m.restore();
  return { s, o, f };
}

describe('U1 (F-B51): every foreign completion still `completing` is resolved later, whatever the balances and open requests', () => {
  it('another party settled it first and the read right after failed: resolved on a later pass (lost), never settled again; what waits at the address is deposited', async () => {
    const { s, o, f } = await deferredForeignCompletion(h, 'u1o', (id) => {
      const realSettle = h.vault.settle.bind(h.vault);
      const realOpen = h.vault.openRequests.bind(h.vault);
      let failReads = 0;
      h.vault.openRequests = async (k) => {
        if (failReads > 0) {
          failReads--;
          throw new Error('the indexer is unreachable');
        }
        return realOpen(k);
      };
      h.vault.settle = async (i) => {
        if (i.requestId === id && h.vault.requests.has(id)) {
          h.vault.griefSettle(id, 'success');
          failReads = 1;
        }
        return realSettle(i);
      };
      return {
        restore: () => {
          h.vault.settle = realSettle;
          h.vault.openRequests = realOpen;
        },
      };
    });
    // No balance change and no open request names it any more: only the periodic resolution can.
    await passes(h, 6);
    const rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere).toEqual([
      expect.objectContaining({ kind: 'deposit', requestId: f.requestId, amount: '1', lost: true }),
    ]);
    expect(rec.deposit!.foreign!.find((x) => x.requestId === f.requestId)!.status).toBe('lost');
    expect(settlesOf(h, 'completeDeposit', f.requestId)).toBe(1);
    // What waited at the address (all but the lost unit) was deposited: Bridge back is on offer.
    const rest = (BigInt(o.amount) - 1n).toString();
    expect(rec.state).toBe('partial');
    expect((await view(h, s, o.swapToken)).partial).toMatchObject({
      minted: rest,
      remaining: '0',
      options: ['bridge-back'],
    });
  });

  it('the sponsor’s own completion landed, its answer was lost and the lookup failed for a moment: found on a later pass, counted, and the rest deposited (minted)', async () => {
    const { s, o, f } = await deferredForeignCompletion(h, 'u1s', (id) => {
      const realSettle = h.vault.settle.bind(h.vault);
      const realFind = h.vault.findTransaction.bind(h.vault);
      let lookupDown = false;
      h.vault.findTransaction = async (x) => {
        if (lookupDown) throw new Error('the indexer timed out');
        return realFind(x);
      };
      h.vault.settle = async (i) => {
        if (i.requestId === id) {
          h.vault.settleFailure = 'lost-landed';
          lookupDown = true;
        }
        return realSettle(i);
      };
      return {
        restore: () => {
          h.vault.settle = realSettle;
          lookupDown = false;
        },
      };
    });
    await passes(h, 6);
    const rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere ?? []).toEqual([]);
    expect(rec.deposit!.foreign!.find((x) => x.requestId === f.requestId)!.status).toBeUndefined();
    expect(settlesOf(h, 'completeDeposit', f.requestId)).toBe(1);
    expect(rec.state).toBe('minted');
    expect(rec.deposit!.mintedTotal).toBe(o.amount);
  });
});

// ── U2 (F-B52): only observed sweeps explain a drop ─────────────────────────────

/** Auditor A's R4-F-A41c: the sponsor's own sweep loses the nonce race to a griefer's 1-unit request
 *  that the griefer completes itself at once (the sponsor never sees it open). `signed`: the sweep's
 *  own transaction fields (its request's), when the test needs them. */
async function griefedSweep(
  hh: Harness,
  tag: string,
  signed?: { nonce: bigint; gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint },
) {
  const s = bidSwap(hh, Wallet.createRandom(), tag);
  const o = await openSwap(hh, s);
  fund(hh, o);
  const hold = gate();
  hh.vault.defaultRelay = { kind: 'never-executed', beforeBroadcast: hold.promise };
  await hh.swaps.pollDeposits();
  await tick();
  hh.vault.evm.transfer(o.erc20Address, o.depositAddress, VAULT_EVM, 1n, signed ? { signed } : {});
  hh.vault.evm.bumpNonce(o.depositAddress);
  hh.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei) - 51_577n * 2n * GWEI);
  hold.open();
  await hh.swaps.idle();
  hh.vault.defaultRelay = {};
  return { s, o };
}

describe('U2 (F-B52): a request that never swept does not cancel a sweep another party settled', () => {
  it('a dummy request for the whole pay amount at an unused nonce with gas limit 1: the lost unit is recorded, and what waits at the address is deposited', async () => {
    const { s, o } = await griefedSweep(h, 'u2');
    // The vault takes any gas limit above 0 (`startWithdraw`'s and `startDeposit`'s only check).
    await foreignDeposit(h, s, o.erc20Address, BigInt(o.amount), 7n, { gasLimit: 1n });
    await passes(h, 4);
    const rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere).toEqual([
      expect.objectContaining({ kind: 'deposit', attested: 'success', amount: '1', lost: true }),
    ]);
    expect(rec.state).toBe('partial');
    const rest = (BigInt(o.amount) - 1n).toString();
    expect((await view(h, s, o.swapToken)).partial).toEqual({
      minted: '0',
      remaining: rest,
      atAddress: rest,
      options: ['wait'],
    });
    // The page tops the sweep ETH up: the sponsor deposits what waits there (the dummy never competes).
    h.vault.evm.setEth(o.depositAddress, BigInt(rec.sweepGas.ethWei));
    h.vault.sweepsMove = true;
    await passes(h, 3);
    expect((await view(h, s, o.swapToken)).partial).toMatchObject({
      minted: rest,
      remaining: '0',
      options: ['bridge-back'],
    });
  });

  it('a dummy that copies the settled sweep’s nonce and amount but not its signed fields does not explain it either', async () => {
    const swept = { nonce: 0n, gasLimit: 65_000n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: 2n * GWEI };
    const { s } = await griefedSweep(h, 'u2n', swept);
    const s0 = h.store.get(s.swapId)!;
    await foreignDeposit(h, s, s0.pay.erc20Address, 1n, 0n, { gasLimit: 1n });
    await passes(h, 4);
    expect(h.store.get(s.swapId)!.settledElsewhere).toEqual([expect.objectContaining({ amount: '1', lost: true })]);
  });

  it('(control) a request whose own signed sweep executed is still pending, not lost: the sponsor completes it and the swap is minted', async () => {
    const s = bidSwap(h, Wallet.createRandom(), 'u2c');
    const o = await openSwap(h, s);
    fund(h, o);
    const hold = gate();
    h.vault.defaultRelay = { kind: 'never-executed', beforeBroadcast: hold.promise };
    await h.swaps.pollDeposits();
    await tick();
    const f = await foreignDeposit(h, s, o.erc20Address, 1n, 0n);
    h.vault.sweep(f.requestId);
    hold.open();
    await h.swaps.idle();
    h.vault.defaultRelay = {};
    // Not attested for a while: the drop is read and the logs are counted while it is still open.
    await passes(h, 4);
    expect(h.store.get(s.swapId)!.settledElsewhere ?? []).toEqual([]);
    h.vault.attestations.set(f.requestId, 'success');
    h.vault.sweepsMove = true;
    await passes(h, 4);
    const rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere ?? []).toEqual([]);
    expect(rec.state).toBe('minted');
    expect(rec.deposit!.mintedTotal).toBe(o.amount);
  });
});

describe('U2: the live reader reads a sweep’s own transaction (eth_getTransactionByHash)', () => {
  const HASH = `0x${'ab'.repeat(32)}`;
  const FROM = '0xFA0D1f6448c87d7a5ab437492Ca5865D68C4f55F';
  const mined = {
    hash: HASH,
    from: FROM,
    nonce: '0x0',
    gas: '0xfde8',
    maxFeePerGas: '0xb2d05e00',
    maxPriorityFeePerGas: '0x77359400',
    gasPrice: '0x3b9aca00',
    blockNumber: '0xb4b3a0',
  };
  it('reads the sender, nonce, gas limit and both fee fields; pending, unknown or another transaction is null', async () => {
    const seen: string[] = [];
    const reader = jsonRpcEvmReader('http://rpc', async (_u, init) => {
      const q = JSON.parse(String(init!.body)) as { id: number; method: string; params: unknown[] };
      seen.push(`${q.method} ${JSON.stringify(q.params)}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: q.id, result: mined }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    expect(await reader.transaction(HASH)).toEqual({
      hash: HASH,
      from: FROM.toLowerCase(),
      nonce: 0n,
      gasLimit: 65_000n,
      maxFeePerGas: 3n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
    });
    expect(seen).toEqual([`eth_getTransactionByHash ["${HASH}"]`]);
    expect(parseTransaction({ ...mined, blockNumber: null }, HASH)).toBeNull();
    expect(parseTransaction(null, HASH)).toBeNull();
    expect(parseTransaction({ ...mined, hash: `0x${'cd'.repeat(32)}` }, HASH)).toBeNull();
    // A legacy transaction: its gas price as both fee fields.
    const { maxFeePerGas: _f, maxPriorityFeePerGas: _p, ...legacy } = mined;
    expect(parseTransaction(legacy, HASH)).toMatchObject({ maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI });
  });
});

// ── U3 (F-A51): the sponsor's own settle judged another party's is re-checked for a day ──

describe('U3 (F-A51): a "settled elsewhere" judgment is re-checked by the sponsor’s own settle identifiers for a day', () => {
  it('a replica’s index missed the sponsor’s own landed completion: failed but not final (Resume offered) while re-checked; found → minted, nothing lost', async () => {
    const { s, o, hold } = await depositHeldAtAttestation(h, 'u3d');
    h.vault.settleFailure = 'lost-landed';
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, 0n); // its own sweep took the tokens
    const index = laggingIndex(h);
    hold.open();
    await h.swaps.idle();
    await closerFor3h(h);
    const mid = structuredClone(h.store.get(s.swapId)!);
    expect(mid).toMatchObject({ state: 'failed', reason: SETTLED_ELSEWHERE_REASON });
    expect(mid.settledElsewhere).toEqual([expect.objectContaining({ lost: true, amount: o.amount })]);
    // Not final while the sponsor's own completion may still be found.
    expect(mid.recoverable).toBe(true);
    expect(mid.message).toMatch(/still checking/);
    const midView = await view(h, s, o.swapToken);
    expect(midView.recoverable).toBe(true);
    // The page: failed, the lost part on its record, and Resume on offer while the sponsor re-checks.
    const page = applyView(webRecord(s), WebSwapViewSchema.parse(JSON.parse(JSON.stringify(midView))), 2);
    expect(page.phase).toBe('failed');
    expect(page.lost).toEqual([expect.objectContaining({ amount: o.amount })]);
    expect(isResumable(page)).toBe(true);
    // The index catches up: the sponsor's own completion is found, the judgment is reverted.
    index.caughtUp = true;
    await closerFor3h(h);
    const r = h.store.get(s.swapId)!;
    expect(r.state).toBe('minted');
    expect(r.deposit!.mintedTotal).toBe(o.amount);
    expect(r.deposit!.stages.at(-1)).toMatchObject({ stage: 'completed' });
    expect(settlesOf(h, 'completeDeposit')).toBe(1);
    const v = await view(h, s, o.swapToken);
    // The view says nothing is lost any more: an empty list, which clears the page's lost note.
    expect(v.settledElsewhere).toEqual([]);
    const web = WebSwapViewSchema.parse(JSON.parse(JSON.stringify(v)));
    expect(
      lostRecord({ lost: [{ kind: 'deposit', colour: BID.pay.token.midnightColour, amount: o.amount }] }, web),
    ).toBe(undefined);
    // The flow continues: the take is proven.
    expect((await post(h, SWAP_PATHS.prove(s.swapId), takeBody(s), o.swapToken)).status).toBe(200);
  });

  it('Resume while it is re-checked: the re-open looks again at once and continues the swap when the sponsor’s own completion is found', async () => {
    const { s, o, hold } = await depositHeldAtAttestation(h, 'u3r');
    h.vault.settleFailure = 'lost-landed';
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, 0n);
    const index = laggingIndex(h);
    hold.open();
    await h.swaps.idle();
    await closerFor3h(h);
    expect(h.store.get(s.swapId)!).toMatchObject({ state: 'failed', recoverable: true });
    // Resume before it is found: still failed, still recoverable, with when to look again.
    const early = await openSwap(h, s);
    expect(early.swap).toMatchObject({ state: 'failed', recoverable: true });
    expect(early.swap.retryAt).toBeGreaterThan(Math.floor(h.now.ms / 1000));
    index.caughtUp = true;
    const again = await openSwap(h, s);
    expect(again.swap.state).toBe('minted');
    expect(again.swap.settledElsewhere).toEqual([]);
  });

  it('nothing found within the day: the judgment becomes final (not recoverable), and a re-open does not revive it', async () => {
    const { s, o, hold } = await depositHeldAtAttestation(h, 'u3f');
    h.vault.settleFailure = 'lost-landed';
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, 0n);
    laggingIndex(h); // never catches up
    hold.open();
    await h.swaps.idle();
    await closerFor3h(h);
    expect(h.store.get(s.swapId)!.recoverable).toBe(true);
    h.now.ms += DAY;
    await closerFor3h(h);
    const r = h.store.get(s.swapId)!;
    expect(r).toMatchObject({ state: 'failed', reason: SETTLED_ELSEWHERE_REASON, recoverable: false });
    expect(r.message).not.toMatch(/still checking/);
    const again = await openSwap(h, s);
    expect(again.swap).toMatchObject({ state: 'failed', recoverable: false });
    expect(settlesOf(h, 'completeDeposit')).toBe(1);
  });

  it('a withdrawal: the sponsor’s own refund judged another party’s is found later: back to minted with the retry signal, nothing lost', async () => {
    const { s, token, hold } = await withdrawHeldAtAttestation(h, 'u3w', 'never-executed');
    h.vault.settleFailure = 'lost-landed';
    const index = laggingIndex(h);
    hold.open();
    await h.swaps.idle();
    await closerFor3h(h);
    const mid = structuredClone(h.store.get(s.swapId)!);
    expect(mid).toMatchObject({ state: 'failed', reason: SETTLED_ELSEWHERE_REASON, recoverable: true });
    index.caughtUp = true;
    await closerFor3h(h);
    const r = h.store.get(s.swapId)!;
    expect(r.state).toBe('minted');
    expect(r.withdrawals.at(-1)!.stage).toBe('refunded');
    const v = await view(h, s, token);
    expect(v.withdrawal).toMatchObject({ last: 'refunded', retry: true });
    expect(v.settledElsewhere).toEqual([]);
    expect(settlesOf(h, 'refundWithdraw')).toBe(1);
  });

  it('(control) a judgment where the sponsor never submitted a settle of its own is final at once (nothing to re-check)', async () => {
    const { s, o, hold, requestId } = await depositHeldAtAttestation(h, 'u3n');
    h.vault.griefSettle(requestId, 'success');
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, 0n);
    hold.open();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!).toMatchObject({
      state: 'failed',
      reason: SETTLED_ELSEWHERE_REASON,
      recoverable: false,
    });
  });
});

// ── U5 (F-A52): the view carries at most 16 entries, the page reads more ───────

describe('U5 (F-A52): settledElsewhere is capped by the sponsor, and the page tolerates more', () => {
  const entry = (i: number, lost: boolean, amount = '0') => ({
    kind: 'deposit' as const,
    requestId: hex32(`elsewhere-${i}`),
    attested: (lost ? 'success' : 'never-executed') as 'success' | 'never-executed',
    colour: BID.pay.token.midnightColour,
    amount,
    lost,
    at: 1_000 + i,
  });

  it('17 entries on the record (probe R5-view-cap): the view sends 16, keeps every lost one, and the page reads it', async () => {
    const m = await mintedSwap(h, bidSwap(h, Wallet.createRandom(), 'cap17'));
    const rec = h.store.get(m.s.swapId)!;
    rec.settledElsewhere = [entry(0, true, '5'), ...Array.from({ length: 16 }, (_, i) => entry(i + 1, false))];
    h.store.put(rec);
    const raw = JSON.parse(JSON.stringify(await view(h, m.s, m.token))) as SwapView;
    expect(raw.settledElsewhere).toHaveLength(16);
    expect(raw.settledElsewhere!.filter((e) => e.lost)).toEqual([expect.objectContaining({ amount: '5' })]);
    expect(WebSwapViewSchema.safeParse(raw).success).toBe(true);
  });

  it('more lost entries than fit: the oldest are summed into one, so the lost total is kept', async () => {
    const m = await mintedSwap(h, bidSwap(h, Wallet.createRandom(), 'cap20'));
    const rec = h.store.get(m.s.swapId)!;
    rec.settledElsewhere = Array.from({ length: 20 }, (_, i) => entry(i, true, String(i + 1)));
    h.store.put(rec);
    const v = await view(h, m.s, m.token);
    expect(v.settledElsewhere).toHaveLength(16);
    const total = (v.settledElsewhere ?? []).reduce((n, e) => n + BigInt(e.amount), 0n);
    expect(total).toBe(210n); // 1 + 2 + … + 20
    expect(WebSwapViewSchema.safeParse(JSON.parse(JSON.stringify(v))).success).toBe(true);
  });

  it('the page reads a view with more than 16 entries (an older sponsor)', () => {
    const v = {
      swapId: 'a'.repeat(64),
      state: 'minted',
      settledElsewhere: Array.from({ length: 40 }, (_, i) => entry(i, false)),
    };
    const parsed = WebSwapViewSchema.safeParse(v);
    expect(parsed.success).toBe(true);
  });
});

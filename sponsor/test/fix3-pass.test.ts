// The P4.2 round-3 fix pass, sponsor side (plan 00048 P4.2-fix3, lane FS3; audit
// audits/00048-evm-midnight-transparent-security.md, "Consolidation, round 3" rows S1–S8). Each
// describe block names its row; each test failed before its fix (several started from auditor A's
// round-3 probes, evidence/00048-evm-midnight-transparent/p4-audit/probes-a3/). S7 is an accepted
// policy (../src/validate/rules.ts header), not a fix.

import { SWAP_PATHS, SwapViewSchema, type SwapView } from '@evm-midnight-transparent/core';
import { Wallet } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';

import { partialOf } from '../../web/src/swap/partial.js';
import { SwapViewSchema as WebSwapViewSchema } from '../../web/src/swap/sponsor-client.js';
import { swapView, type SwapRecord } from '../src/swaps/model.js';
import { MemorySwapStore } from '../src/swaps/store.js';
import { VAULT_EVM, gate } from './fakes.js';
import {
  BID,
  bidSwap,
  bidTake,
  coinOutput,
  fund,
  get,
  harness,
  hex32,
  mintedSwap,
  openBody,
  openSwap,
  post,
  takeBody,
  testConfig,
  tok,
  txHex,
  withdrawFor,
  type Harness,
  type SwapInput,
  type WalletCoin,
} from './harness.js';

const GWEI = 1_000_000_000n;
const tick = () => new Promise((r) => setTimeout(r, 20));
const MIN = 60_000;

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

const errorOf = async (res: Response) =>
  ((await res.json()) as { error?: { code: string; detail?: string } }).error ?? { code: '' };

const proveWithdraw = (
  h: Harness,
  s: SwapInput,
  token: string,
  w: { tx: Parameters<typeof txHex>[0]; coinNonce: string; evmNonce: bigint },
  walletOutputs?: WalletCoin[],
) =>
  post(
    h,
    SWAP_PATHS.prove(s.swapId),
    {
      purpose: 'withdraw',
      tx: txHex(w.tx),
      coinNonce: w.coinNonce,
      evmNonce: w.evmNonce.toString(),
      ...(walletOutputs ? { walletOutputs } : {}),
    },
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

type Params = { evmNonce: string; amount: string; gas: { maxFeePerGas: string; maxPriorityFeePerGas: string } };

/** withdraw-params, then the browser's build on them (the gas and the amount passed through). */
async function paramsAndBuild(hh: Harness, s: SwapInput, token: string, kind: 'swap' | 'bridge-back', tag = 'c') {
  const res = await get(hh, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=${kind}`, token);
  expect(res.status).toBe(200);
  const p = (await res.json()) as Params;
  return {
    params: p,
    ...withdrawFor(hh, s, kind, {
      evmNonce: BigInt(p.evmNonce),
      coinNonce: hex32(`${tag}-${p.evmNonce}`),
      amount: BigInt(p.amount),
      maxFeePerGas: BigInt(p.gas.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(p.gas.maxPriorityFeePerGas),
    }),
  };
}

function vaultReady(hh: Harness) {
  hh.vault.evm.nonces.set(VAULT_EVM.toLowerCase(), { latest: 9n, pending: 9n });
  hh.vault.evm.setEth(VAULT_EVM, 10n ** 17n);
  for (const t of [tok('stkA'), tok('USDC')]) hh.vault.evm.setErc20(t.sepoliaAddress, VAULT_EVM, 10n ** 12n);
}

/** An indexer whose vault reads do not show withdraw requests, and whose latest block lags `lagMs`
 *  behind the clock (0: its head is fresh but its state misses them, e.g. a replica behind). */
function hideWithdrawRequests(hh: Harness, lagMs: number) {
  const real = hh.vault.openRequests.bind(hh.vault);
  let on = true;
  hh.vault.indexerLagMs = lagMs;
  hh.vault.openRequests = async (kind) => {
    const o = await real(kind);
    return on && kind === 'withdraw' ? { ...o, ids: [] } : o;
  };
  return {
    off() {
      on = false;
      hh.vault.indexerLagMs = 0;
    },
  };
}

/** Anyone's `startDeposit` for the swap's recipient (it is permissionless). */
const foreignDeposit = (
  hh: Harness,
  s: SwapInput,
  erc20: string,
  amount: bigint,
  gas: { gasLimit?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint } = {},
  evmNonce = 0n,
) =>
  hh.vault.startDeposit({
    recipientCoinPk: s.payload.tempCoinPk,
    erc20,
    amount,
    gas: {
      gasLimit: gas.gasLimit ?? 65_000n,
      maxFeePerGas: gas.maxFeePerGas ?? 3n * GWEI,
      maxPriorityFeePerGas: gas.maxPriorityFeePerGas ?? 2n * GWEI,
      keyVersion: 1n,
    },
    evmNonce,
  });

/**
 * A funded swap whose own sweep loses the deposit address's nonce race to anyone's 1-unit
 * `startDeposit` (auditor A's probe R3-N2c): the foreign request is mined and attested, the
 * sponsor's own sweep is attested never executed. The foreign sweep paid its gas from the address.
 */
async function griefedSwap(hh: Harness, tag = 'g') {
  const s = bidSwap(hh, Wallet.createRandom(), tag);
  const o = await openSwap(hh, s);
  fund(hh, o);
  const hold = gate();
  hh.vault.defaultRelay = { kind: 'never-executed', beforeBroadcast: hold.promise };
  await hh.swaps.pollDeposits();
  await tick();
  const foreign = await foreignDeposit(hh, s, o.erc20Address, 1n);
  hh.vault.evm.setErc20(o.erc20Address, o.depositAddress, BigInt(o.amount) - 1n);
  hh.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei) - 51_577n * 2n * GWEI);
  hh.vault.attestations.set(foreign.requestId, 'success');
  hold.open();
  await hh.swaps.idle();
  hh.vault.defaultRelay = {};
  hh.now.ms += 3 * MIN; // past the reconciliation's pacing
  await hh.swaps.pollDeposits();
  await hh.swaps.idle();
  await hh.swaps.pollDeposits(); // the next read of the address
  await hh.swaps.idle();
  return { s, o, foreign };
}

let h: Harness;
beforeEach(() => {
  h = harness({ config: testConfig(LIMITS) });
  vaultReady(h);
});

// ── S1 ─────────────────────────────────────────────────────────────────────────

describe('S1: "not included" needs a vault read that covers the submission’s expiry; not-included attempts are re-checked for a day', () => {
  it('a lagging indexer never decides it (probe R3-R5): the start stays uncertain, keeps its nonce, and is adopted after the catch-up', async () => {
    const a = await takenSwap(h, bidSwap(h, Wallet.createRandom(), 'ua'));
    const b = await takenSwap(h, bidSwap(h, Wallet.createRandom(), 'ub'));
    const lag = hideWithdrawRequests(h, 30 * MIN);
    const wa = withdrawFor(h, a.s, 'swap', { coinNonce: hex32('ua') });
    expect((await proveWithdraw(h, a.s, a.token, wa)).status).toBe(200);
    h.vault.submitFailure = 'lost-landed'; // the start lands; the submission reports an error
    expect((await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token)).status).toBe(202);
    await h.swaps.idle();
    const w0 = h.store.get(a.s.swapId)!.withdrawals.at(-1)!;
    expect(w0.stage).toBe('submission-uncertain');
    h.now.ms += 16 * MIN;
    await h.swaps.adoptLateStarts();
    const s2 = h.store.get(a.s.swapId)!;
    expect(s2.state).toBe('withdrawing');
    expect(s2.withdrawals.at(-1)!.stage).toBe('submission-uncertain');
    // A's nonce is still reserved: B signs the next one.
    const pb = (await (await get(h, `${SWAP_PATHS.withdrawParams(b.s.swapId)}?kind=swap`, b.token)).json()) as Params;
    expect(pb.evmNonce).toBe((wa.evmNonce + 1n).toString());
    lag.off(); // the indexer catches up: A's request is in the vault
    expect(await h.swaps.adoptLateStarts()).toEqual([a.s.swapId]);
    await h.swaps.idle();
    expect(
      h.store
        .get(a.s.swapId)!
        .withdrawals.at(-1)!
        .stages.map((x) => x.stage),
    ).toContain('adopted');
    // Its expiry was recorded before the node saw it (the balancing's time to live).
    expect(w0.expiresAtMs).toBeGreaterThan(0);
  });

  it('an attestation lookup that fails never settles it: it stays uncertain until the lookup works', async () => {
    const a = await takenSwap(h, bidSwap(h, Wallet.createRandom(), 'att'));
    const wa = withdrawFor(h, a.s, 'swap', { coinNonce: hex32('att') });
    expect((await proveWithdraw(h, a.s, a.token, wa)).status).toBe(200);
    h.vault.submitFailure = 'lost'; // it did not land
    expect((await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token)).status).toBe(202);
    await h.swaps.idle();
    h.vault.attestationFails = true;
    h.now.ms += 16 * MIN;
    await h.swaps.adoptLateStarts();
    expect(h.store.get(a.s.swapId)!.withdrawals.at(-1)!.stage).toBe('submission-uncertain');
    h.vault.attestationFails = false;
    await h.swaps.adoptLateStarts();
    const w = h.store.get(a.s.swapId)!.withdrawals.at(-1)!;
    expect(w).toMatchObject({ stage: 'failed', resolution: 'not-included' });
    expect(h.store.get(a.s.swapId)!.state).toBe('minted');
  });

  it('an attempt judged not included is re-checked: if its request appears within a day it is adopted again (the nonce pair is then settled by the replacement rule)', async () => {
    const a = await takenSwap(h, bidSwap(h, Wallet.createRandom(), 'ra'));
    const b = await takenSwap(h, bidSwap(h, Wallet.createRandom(), 'rb'));
    // A fresh head, but a state that misses the request (e.g. a replica behind the head's).
    const replica = hideWithdrawRequests(h, 0);
    const wa = withdrawFor(h, a.s, 'swap', { coinNonce: hex32('ra') });
    expect((await proveWithdraw(h, a.s, a.token, wa)).status).toBe(200);
    h.vault.submitFailure = 'lost-landed';
    expect((await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token)).status).toBe(202);
    await h.swaps.idle();
    h.now.ms += 16 * MIN;
    await h.swaps.adoptLateStarts();
    expect(h.store.get(a.s.swapId)!).toMatchObject({ state: 'minted' });
    expect(h.store.get(a.s.swapId)!.withdrawals.at(-1)!.resolution).toBe('not-included');
    // The nonce is free again: B takes it (no gap in the vault account's nonces).
    const pb = (await (await get(h, `${SWAP_PATHS.withdrawParams(b.s.swapId)}?kind=swap`, b.token)).json()) as Params;
    expect(pb.evmNonce).toBe(wa.evmNonce.toString());
    // And A's own retry is not blocked by the re-check.
    expect((await get(h, `${SWAP_PATHS.withdrawParams(a.s.swapId)}?kind=swap`, a.token)).status).toBe(200);
    replica.off();
    h.now.ms += 60 * MIN;
    expect(await h.swaps.adoptLateStarts()).toEqual([a.s.swapId]);
    const ra = h.store.get(a.s.swapId)!;
    expect(ra.state).toBe('withdrawing');
    expect(ra.withdrawals.at(-1)!.stages.map((x) => x.stage)).toContain('adopted');
    expect(h.swaps.reservations().map((r) => r.nonce)).toContain(wa.evmNonce);
    await h.swaps.idle();
  });

  it('the re-check ends after a day', async () => {
    const a = await takenSwap(h, bidSwap(h, Wallet.createRandom(), 'end'));
    const replica = hideWithdrawRequests(h, 0);
    const wa = withdrawFor(h, a.s, 'swap', { coinNonce: hex32('end') });
    expect((await proveWithdraw(h, a.s, a.token, wa)).status).toBe(200);
    h.vault.submitFailure = 'lost-landed';
    await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token);
    await h.swaps.idle();
    h.now.ms += 16 * MIN;
    await h.swaps.adoptLateStarts();
    replica.off();
    h.now.ms += 25 * 60 * MIN;
    expect(await h.swaps.adoptLateStarts()).toEqual([]);
  });
});

// ── S2 ─────────────────────────────────────────────────────────────────────────

describe('S2: foreign and partial deposit sweeps are reconciled; a partial deposit can finish or go back', () => {
  it('a foreign 1-unit sweep that won the race (probe R3-N2c): the swap is PARTIAL, and the sponsor deposits the remainder once the sweep ETH is back', async () => {
    const { s, o } = await griefedSwap(h);
    const rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('partial');
    const v = await view(h, s, o.swapToken);
    expect(v.partial).toEqual({
      minted: '1',
      remaining: (BigInt(o.amount) - 1n).toString(),
      atAddress: (BigInt(o.amount) - 1n).toString(),
      options: ['wait', 'bridge-back'],
    });
    // Neither a take nor a swap withdrawal while partial.
    expect((await post(h, SWAP_PATHS.prove(s.swapId), takeBody(s), o.swapToken)).status).toBe(409);
    expect((await get(h, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=swap`, o.swapToken)).status).toBe(409);
    // Never failed by age.
    h.now.ms += 2 * 86_400_000;
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('partial');
    // The page tops the sweep ETH back up: the sponsor deposits exactly the remainder by itself.
    h.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei));
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const done = h.store.get(s.swapId)!;
    expect(done.state).toBe('minted');
    expect(done.deposit!.mintedTotal).toBe(o.amount);
    expect(h.vault.log.filter((l) => l.startsWith('startDeposit')).at(-1)).toContain(` ${BigInt(o.amount) - 1n} `);
  });

  it('a sweep between two polls (never seen at the address) is reconciled from the vault’s requests: the swap mints', async () => {
    const s = bidSwap(h, Wallet.createRandom(), 'between');
    const o = await openSwap(h, s);
    // The funds arrived AND left before any read: anyone's full-amount request swept them.
    const foreign = await foreignDeposit(h, s, o.erc20Address, BigInt(o.amount));
    h.vault.attestations.set(foreign.requestId, 'success');
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.deposit!.stages.map((x) => x.stage)).toContain('adopted');
    expect(rec.state).toBe('minted');
  });

  it('Bridge back from partial returns what arrived; the rest at the address is deposited and returned too; then done', async () => {
    const { s, o } = await griefedSwap(h, 'bb');
    // Bridge back what arrived (1 unit): withdraw-params answers the minted amount.
    const w = await paramsAndBuild(h, s, o.swapToken, 'bridge-back', 'p1');
    expect(w.params.amount).toBe('1');
    expect((await proveWithdraw(h, s, o.swapToken, w)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, o.swapToken)).status).toBe(202);
    await h.swaps.idle();
    // The address still holds the rest: back to partial, nothing held, waiting for the sweep ETH.
    let v = await view(h, s, o.swapToken);
    expect(v.state).toBe('partial');
    expect(v.partial).toMatchObject({ minted: '0', options: ['wait'] });
    h.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei));
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    v = await view(h, s, o.swapToken);
    expect(v.state).toBe('partial');
    expect(v.partial).toMatchObject({
      minted: (BigInt(o.amount) - 1n).toString(),
      remaining: '0',
      options: ['bridge-back'],
    });
    // Nothing is left to deposit: the poll starts nothing more, whatever the address shows.
    const starts = h.vault.log.filter((l) => l.startsWith('startDeposit')).length;
    h.now.ms += 2 * 86_400_000;
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect(h.vault.log.filter((l) => l.startsWith('startDeposit'))).toHaveLength(starts);
    const w2 = await paramsAndBuild(h, s, o.swapToken, 'bridge-back', 'p2');
    expect(w2.params.amount).toBe((BigInt(o.amount) - 1n).toString());
    expect((await proveWithdraw(h, s, o.swapToken, w2)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w2.tx) }, o.swapToken)).status).toBe(202);
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!).toMatchObject({ state: 'done', outcome: 'bridged-back' });
  });

  it('a refunded Bridge back from partial returns to partial, and the page is told to retry', async () => {
    const { s, o } = await griefedSwap(h, 'rf');
    const w = await paramsAndBuild(h, s, o.swapToken, 'bridge-back', 'rf');
    expect((await proveWithdraw(h, s, o.swapToken, w)).status).toBe(200);
    h.vault.defaultRelay = { kind: 'never-executed' };
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, o.swapToken)).status).toBe(202);
    await h.swaps.idle();
    h.vault.defaultRelay = {};
    const v = await view(h, s, o.swapToken);
    expect(v.state).toBe('partial');
    expect(v.withdrawal).toMatchObject({ last: 'refunded', retry: true });
    expect(v.partial!.minted).toBe('1');
  });

  it('a wallet holding the pay amount in several coins (after partial deposits) can still take: up to MAX_COINS coins in', async () => {
    const m = await mintedSwap(h);
    const received: WalletCoin = { nonce: hex32('recv3'), colour: BID.receive.token.midnightColour, value: '1000000' };
    const tx = bidTake({
      shielded: {
        inputs: [0, 1, 2].map((i) => ({ nullifier: hex32(`pay-coin-${i}`), contract: null })),
        outputs: [coinOutput(received, m.s.payload.tempCoinPk)],
      },
    });
    const res = await post(
      h,
      SWAP_PATHS.prove(m.s.swapId),
      { purpose: 'take', tx: txHex(tx), walletOutputs: [received] },
      m.token,
    );
    expect(res.status).toBe(200);
  });
});

// ── S3 ─────────────────────────────────────────────────────────────────────────

describe('S3: a request is adopted only if BOTH fee fields meet the live sweep policy; otherwise the sponsor posts its own', () => {
  it('this swap’s token, amount, nonce and gas limit, affordable, but a zero tip: not adopted; the sponsor outbids it on both fields once the ETH allows', async () => {
    const s = bidSwap(h, Wallet.createRandom(), 'tip');
    const o = await openSwap(h, s);
    fund(h, o);
    const low = await foreignDeposit(h, s, o.erc20Address, BigInt(o.amount), {
      gasLimit: BigInt(o.sweepGas.gasLimit),
      maxFeePerGas: BigInt(o.sweepGas.maxFeePerGas),
      maxPriorityFeePerGas: 0n,
    });
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    let rec = h.store.get(s.swapId)!;
    expect(rec.deposit!.stages.map((x) => x.stage)).not.toContain('adopted');
    expect(rec.deposit!.requestId).not.toBe(low.requestId);
    // Outbidding it needs 10% more ETH than the address holds: the swap asks for it (sweepGas rises).
    expect(BigInt(rec.sweepGas.ethWei)).toBeGreaterThan(BigInt(o.sweepGas.ethWei));
    h.vault.evm.setEth(o.depositAddress, BigInt(rec.sweepGas.ethWei));
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('minted');
    const own = [...h.vault.log].reverse().find((l) => l.startsWith('startDeposit'))!;
    const fee = BigInt(own.split('x').at(-1)!);
    expect(fee * 100n).toBeGreaterThanOrEqual(BigInt(o.sweepGas.maxFeePerGas) * 110n);
  });

  it('a fee cap under 1.25 × the live base fee + tip is not adopted either', async () => {
    const s = bidSwap(h, Wallet.createRandom(), 'cap');
    const o = await openSwap(h, s);
    fund(h, o);
    const low = await foreignDeposit(h, s, o.erc20Address, BigInt(o.amount), {
      gasLimit: BigInt(o.sweepGas.gasLimit),
      maxFeePerGas: 1n * GWEI, // under 1.25 × 0.952 + 0.5 gwei
      maxPriorityFeePerGas: 500_000_000n,
    });
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.deposit!.requestId).not.toBe(low.requestId);
    expect(rec.deposit!.stages.map((x) => x.stage)).not.toContain('adopted');
    expect(rec.state).toBe('minted'); // through its own start
    expect(h.vault.log.filter((l) => l.startsWith('startDeposit'))).toHaveLength(2);
  });
});

// ── S4 ─────────────────────────────────────────────────────────────────────────

describe('S4: retention never drops a record with anything left to recover', () => {
  it('a recoverable funded failure is kept past the retention; a finished swap is dropped', async () => {
    const store = new MemorySwapStore(30);
    const hh = harness({ config: testConfig(LIMITS), store });
    vaultReady(hh);
    const failedSwap = bidSwap(hh, Wallet.createRandom(), 'keep');
    const fo = await openSwap(hh, failedSwap);
    fund(hh, fo);
    hh.vault.defaultRelay = { kind: 'never-executed' };
    for (let i = 0; i < 4; i++) {
      await hh.swaps.pollDeposits();
      await hh.swaps.idle();
    }
    hh.vault.defaultRelay = {};
    expect(store.get(failedSwap.swapId)!).toMatchObject({
      state: 'failed',
      reason: 'deposit-attempts',
      recoverable: true,
    });
    const doneSwap = bidSwap(hh, Wallet.createRandom(), 'done');
    const m = await mintedSwap(hh, doneSwap);
    const w = await paramsAndBuild(hh, doneSwap, m.token, 'bridge-back', 'd');
    expect((await proveWithdraw(hh, doneSwap, m.token, w)).status).toBe(200);
    await post(hh, SWAP_PATHS.withdraw(doneSwap.swapId), { tx: txHex(w.tx) }, m.token);
    await hh.swaps.idle();
    expect(store.get(doneSwap.swapId)!.state).toBe('done');
    const later = Math.floor(hh.now.ms / 1000) + 31 * 86_400;
    expect(store.prune(later)).toBe(1);
    expect(store.get(failedSwap.swapId)).toBeDefined();
    expect(store.get(doneSwap.swapId)).toBeUndefined();
  });

  it('nor a finished record with a withdrawal attempt still unresolved', () => {
    const store = new MemorySwapStore(30);
    const rec = {
      swapId: 'aa'.repeat(32),
      state: 'failed',
      recoverable: false,
      reason: 'failed',
      deposit: null,
      withdrawals: [{ stage: 'submission-uncertain', requestId: 'bb'.repeat(32), stages: [] }],
      updatedAt: 0,
    } as unknown as SwapRecord;
    store.put(rec);
    expect(store.prune(365 * 86_400)).toBe(0);
  });
});

// ── S5 ─────────────────────────────────────────────────────────────────────────

describe('S5: IPv6 clients count by /48; a swap is unfunded until its whole amount arrives; the global cap is a backstop', () => {
  /** An app over the same service whose client address the test sets. */
  const withClient = (address: string) => {
    const client = { address };
    return { client, hh: harness({ config: testConfig(LIMITS), client }) };
  };

  it('ten /64s of one /48 are one client (probe R3-F-A21c): capped at 10, and an honest swap still opens', async () => {
    const { client, hh } = withClient('');
    let opened = 0;
    let refusal = '';
    for (let k = 0; k < 10; k++) {
      client.address = `2001:db8:1:${k.toString(16)}::1`;
      for (let i = 0; i < 10; i++) {
        const res = await post(
          hh,
          SWAP_PATHS.swaps,
          await openBody(hh, bidSwap(hh, Wallet.createRandom(), `g-${k}-${i}`)),
        );
        if (res.status === 201) opened++;
        else refusal ||= (await errorOf(res)).detail ?? '';
      }
    }
    expect(opened).toBe(10);
    expect(refusal).toBe('client');
    client.address = '198.51.100.200';
    expect(
      (await post(hh, SWAP_PATHS.swaps, await openBody(hh, bidSwap(hh, Wallet.createRandom(), 'honest')))).status,
    ).toBe(201);
  });

  it('one base unit at the deposit address does not take a swap out of the caps (probe R3-F-A21d)', async () => {
    const { hh } = withClient('203.0.113.77');
    let held = 0;
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 10; i++) {
        const res = await post(
          hh,
          SWAP_PATHS.swaps,
          await openBody(hh, bidSwap(hh, Wallet.createRandom(), `p-${round}-${i}`)),
        );
        if (res.status !== 201) continue;
        const o = (await res.json()) as { erc20Address: string; depositAddress: string };
        hh.vault.evm.setErc20(o.erc20Address, o.depositAddress, 1n);
        held++;
      }
      await hh.swaps.pollDeposits();
    }
    expect(held).toBe(10);
    expect(hh.swaps.budgetStatus().unfundedOpen).toBe(10);
  });

  it('the global cap of unfunded swaps defaults to 1,000 (deposit reads are budgeted per pass)', () => {
    expect(testConfig().swaps.maxUnfunded).toBe(1_000);
  });
});

// ── S6 ─────────────────────────────────────────────────────────────────────────

describe('S6: a foreign completion reserves its settle from the daily budget before it is queued', () => {
  it('two concurrent foreign completions with room for one: only one runs', async () => {
    // A settle costs 2 DUST, a start 1; the budget is 20.
    const hh = harness({
      config: testConfig({
        ...LIMITS,
        SWAP_DUST_PER_SETTLE_SPECKS: (2n * 10n ** 15n).toString(),
        SWAP_DUST_PER_START_SPECKS: (10n ** 15n).toString(),
        SPONSOR_DAILY_DUST_BUDGET: '20',
      }),
    });
    vaultReady(hh);
    const swaps: { s: SwapInput; o: Awaited<ReturnType<typeof openSwap>> }[] = [];
    for (const tag of ['s6a', 's6b']) {
      const s = bidSwap(hh, Wallet.createRandom(), tag);
      const o = await openSwap(hh, s);
      // The token arrives, but no sweep ETH: the sponsor starts nothing of its own.
      hh.vault.evm.setErc20(o.erc20Address, o.depositAddress, BigInt(o.amount));
      swaps.push({ s, o });
    }
    await hh.swaps.pollDeposits();
    // 17 DUST already spent today (another swap's recorded starts): room for one settle and a half,
    // so both completions pass a check that reserves nothing.
    const spent = structuredClone(hh.store.get(swaps[0]!.s.swapId)!);
    spent.swapId = hex32('spent-today');
    spent.tempCoinPk = hex32('spent-coin');
    spent.state = 'done';
    spent.deposit!.stages = Array.from({ length: 17 }, () => ({ stage: 'started', at: Math.floor(hh.now.ms / 1000) }));
    hh.store.put(spent);
    for (const { s, o } of swaps) {
      const f = await foreignDeposit(hh, s, o.erc20Address, 1n);
      hh.vault.attestations.set(f.requestId, 'success');
      hh.vault.evm.setErc20(o.erc20Address, o.depositAddress, BigInt(o.amount) - 1n);
    }
    // Hold the first settle open so both admissions happen before either is recorded.
    const hold = gate();
    const realSettle = hh.vault.settle.bind(hh.vault);
    hh.vault.settle = async (i) => {
      await hold.promise;
      return realSettle(i);
    };
    hh.now.ms += 3 * MIN;
    await hh.swaps.pollDeposits();
    await tick();
    hold.open();
    await hh.swaps.idle();
    expect(hh.vault.settles.filter((x) => x.circuit === 'completeDeposit')).toHaveLength(1);
    const stages = swaps.map(({ s }) => hh.store.get(s.swapId)!.deposit!.stage);
    expect(stages).toContain('budget-wait');
  });
});

// ── S8 ─────────────────────────────────────────────────────────────────────────

describe('S8: approvals are versioned; one made by an older sponsor is proven again', () => {
  it('an approval without the current version (no erased transaction) is refused at /withdraw with the rebuild hint', async () => {
    const { s, token } = await takenSwap(h);
    const w = withdrawFor(h, s, 'swap', { coinNonce: hex32('s8') });
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    // What the b6b5347 sponsor stored: no version, no erased transaction.
    const rec = h.store.get(s.swapId)!;
    const old = { ...rec.provenWithdraw! };
    delete old.v;
    delete old.erased;
    delete old.amount;
    rec.provenWithdraw = old;
    h.store.put(rec);
    const res = await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: 'stale-vault-state', detail: 'approval-outdated' });
    expect(h.vault.submitted).toHaveLength(0);
    expect(h.store.get(s.swapId)!.provenWithdraw).toBeNull();
    // Proven again by this sponsor: accepted.
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
  });
});

// ── The view ─────────────────────────────────────────────────────────────────

describe('the partial view parses with core’s schema (FW3 builds to it)', () => {
  it('present exactly in partial', async () => {
    const { s, o } = await griefedSwap(h, 'view');
    const rec = h.store.get(s.swapId)!;
    expect(SwapViewSchema.parse(JSON.parse(JSON.stringify(swapView(rec)))).partial).toBeDefined();
    const m = await mintedSwap(h, bidSwap(h, Wallet.createRandom(), 'plain'));
    expect(
      SwapViewSchema.parse(JSON.parse(JSON.stringify(swapView(h.store.get(m.s.swapId)!)))).partial,
    ).toBeUndefined();
    expect(o.swapToken).toBeTruthy();
  });
});

// ── Cross-lane: the real sponsor's views through the page's reader (FW3, #13) ──

describe('cross-lane S2: the page reads the real sponsor’s partial views (web/src/swap/partial.ts)', () => {
  it('griefed → partial (wait, bridge-back) → a Bridge back → partial (wait) → the rest deposited → partial (bridge-back)', async () => {
    const { s, o } = await griefedSwap(h, 'x');
    const page = async () => {
      const body = (await (await get(h, SWAP_PATHS.swap(s.swapId), o.swapToken)).json()) as { swap: unknown };
      return partialOf(WebSwapViewSchema.parse(body.swap), BigInt(o.amount));
    };
    const amount = BigInt(o.amount);
    expect(await page()).toMatchObject({ minted: 1n, remaining: amount - 1n, canWait: true, canBridgeBack: true });
    const w = await paramsAndBuild(h, s, o.swapToken, 'bridge-back', 'x1');
    expect((await proveWithdraw(h, s, o.swapToken, w)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, o.swapToken)).status).toBe(202);
    await h.swaps.idle();
    expect(await page()).toMatchObject({ minted: 0n, remaining: amount - 1n, canWait: true, canBridgeBack: false });
    h.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei));
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect(await page()).toMatchObject({ minted: amount - 1n, remaining: 0n, canWait: false, canBridgeBack: true });
  });

  it('a paced remainder start shows its retryAt to the page', async () => {
    const { s, o } = await griefedSwap(h, 'y');
    // A re-arm happened moments ago: the next remainder start waits for the cooldown.
    const rec = h.store.get(s.swapId)!;
    rec.deposit!.rearmTimes = [Math.floor(h.now.ms / 1000)];
    h.store.put(rec);
    h.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei));
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const body = (await (await get(h, SWAP_PATHS.swap(s.swapId), o.swapToken)).json()) as { swap: unknown };
    const p = partialOf(WebSwapViewSchema.parse(body.swap), BigInt(o.amount));
    expect(p?.retryAt).toBe((Math.floor(h.now.ms / 1000) + 1_800) * 1000);
  });
});

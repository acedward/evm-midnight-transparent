// The P4.2 round-2 fix pass, sponsor side (plan 00048 P4.2-fix2, lane FS2; audit
// audits/00048-evm-midnight-transparent-security.md, "Consolidation, round 2" rows R1–R6). Each
// describe block names its row; each test failed before its fix (several started from auditor A's
// round-2 probes, evidence/00048-evm-midnight-transparent/p4-audit/probes-a2/). R2 is also tested
// against a real transaction pool: ./replacement-pool.test.ts.

import { SWAP_PATHS, SwapViewSchema, type SwapView } from '@evm-midnight-transparent/core';
import { Wallet } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';

import { transition } from '../src/swaps/model.js';
import { MemorySwapStore } from '../src/swaps/store.js';
import { StaleCloser } from '../src/swaps/stale.js';
import { VAULT_EVM, gate, summaryWith } from './fakes.js';
import {
  BID,
  bidSwap,
  bidTakeFor,
  coinOutput,
  fund,
  fundOwner,
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
const OTHER_KEY = 'ee'.repeat(32);

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

type Params = { evmNonce: string; gas: { maxFeePerGas: string; maxPriorityFeePerGas: string } };

/** withdraw-params, then the browser's build on them (the gas passed through unchanged). */
async function paramsAndBuild(hh: Harness, s: SwapInput, token: string, kind: 'swap' | 'bridge-back', tag = 'c') {
  const res = await get(hh, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=${kind}`, token);
  expect(res.status).toBe(200);
  const p = (await res.json()) as Params;
  return {
    params: p,
    ...withdrawFor(hh, s, kind, {
      evmNonce: BigInt(p.evmNonce),
      coinNonce: hex32(`${tag}-${p.evmNonce}`),
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

const closer = (hh: Harness) =>
  new StaleCloser({
    config: {
      enabled: true,
      intervalMs: 1000,
      staleAfterMs: 900_000,
      maxPerDay: 100,
      minSponsorDustSpecks: 10n ** 16n,
    },
    service: hh.swaps,
    sponsor: () => ({ configured: true, state: 'synced', synced: true, dustSpecks: 10n ** 20n }),
    log: hh.log,
    now: () => hh.now.ms,
  });

let h: Harness;
beforeEach(() => {
  h = harness({ config: testConfig(LIMITS) });
  vaultReady(h);
});

// ── R1 ─────────────────────────────────────────────────────────────────────────

describe('R1: every output is the vault’s coin or a disclosed coin of the temporary wallet; /withdraw is compared in full', () => {
  it('a take whose received coin goes to another key is refused (undisclosed-output), and proves nothing', async () => {
    const m = await mintedSwap(h);
    const t = bidTakeFor(m.s);
    const toOther = summaryWith(t.tx, {
      inputs: t.tx.shielded.inputs,
      outputs: [coinOutput(t.walletOutputs[0]!, OTHER_KEY)],
    });
    const r1 = await post(
      h,
      SWAP_PATHS.prove(m.s.swapId),
      { purpose: 'take', tx: txHex(toOther), walletOutputs: t.walletOutputs },
      m.token,
    );
    expect(r1.status).toBe(422);
    expect(await errorOf(r1)).toMatchObject({ code: 'invalid-tx', detail: 'undisclosed-output' });
    // Nor without the disclosure at all.
    const r2 = await post(h, SWAP_PATHS.prove(m.s.swapId), { purpose: 'take', tx: txHex(t.tx) }, m.token);
    expect(await errorOf(r2)).toMatchObject({ code: 'invalid-tx', detail: 'undisclosed-output' });
    expect(h.prover.proved).toHaveLength(0);
    expect((await post(h, SWAP_PATHS.prove(m.s.swapId), takeBody(m.s), m.token)).status).toBe(200);
  });

  it('a withdrawal paying its "change" to someone else is refused; change disclosed as the wallet’s is proven', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    const change: WalletCoin = { nonce: hex32('change'), colour: BID.receive.token.midnightColour, value: '7' };
    const stolen = summaryWith(w.tx, {
      inputs: w.tx.shielded.inputs,
      outputs: [...w.tx.shielded.outputs, coinOutput(change, OTHER_KEY)],
    });
    const r1 = await proveWithdraw(h, s, token, { ...w, tx: stolen }, [change]);
    expect(r1.status).toBe(422);
    expect(await errorOf(r1)).toMatchObject({ code: 'invalid-tx', detail: 'undisclosed-output' });
    const own = summaryWith(w.tx, {
      inputs: w.tx.shielded.inputs,
      outputs: [...w.tx.shielded.outputs, coinOutput(change, s.payload.tempCoinPk)],
    });
    expect((await proveWithdraw(h, s, token, { ...w, tx: own }, [change])).status).toBe(200);
  });

  it('a disclosed coin of another token is refused', async () => {
    const m = await mintedSwap(h);
    const t = bidTakeFor(m.s);
    const res = await post(
      h,
      SWAP_PATHS.prove(m.s.swapId),
      {
        purpose: 'take',
        tx: txHex(t.tx),
        walletOutputs: [...t.walletOutputs, { nonce: hex32('x'), colour: tok('stkB').midnightColour, value: '1' }],
      },
      m.token,
    );
    expect(await errorOf(res)).toMatchObject({ code: 'invalid-tx', detail: 'another-colour' });
  });

  it('/withdraw must erase to EXACTLY the proven transaction: the same structure with other bytes is refused', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    // The same calls and coins (the structure digest is equal) but another ciphertext, say.
    const other = { ...w.tx, erased: 'ab'.repeat(64) };
    const res = await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(other) }, token);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('not-proven');
    expect(h.vault.submitted).toHaveLength(0);
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('done');
  });
});

// ── R2 ─────────────────────────────────────────────────────────────────────────

describe('R2: a replacement outbids every competing transfer of its nonce on BOTH fee fields (≥ 10%, rounded up)', () => {
  it('the stuck transfer’s tip is raised too, and a replacement of a replacement outbids the highest of both', async () => {
    const hold = gate();
    const a = await takenSwap(h, bidSwap(h, undefined, 'A'));
    const b = await takenSwap(h, bidSwap(h, undefined, 'B'));
    const c = await takenSwap(h, bidSwap(h, undefined, 'C'));
    h.vault.defaultRelay = { beforeBroadcast: hold.promise };
    const wa = await paramsAndBuild(h, a.s, a.token, 'swap', 'a'); // 10 gwei cap, 1 gwei tip
    expect(wa.params.gas).toMatchObject({
      maxFeePerGas: (10n * GWEI).toString(),
      maxPriorityFeePerGas: GWEI.toString(),
    });
    await proveWithdraw(h, a.s, a.token, wa);
    await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token);
    await tick(); // A signed at nonce 9, not mined
    h.now.ms += 31 * 60_000;
    h.vault.evm.baseFee = 12n * GWEI; // A cannot be mined now: stuck
    const wb = await paramsAndBuild(h, b.s, b.token, 'swap', 'b');
    expect(wb.evmNonce).toBe(9n);
    // Tip 1 gwei → ≥ 1.1 gwei; cap ≥ 11 gwei and ≥ 2 × 12 + 1.1 = 25.1 gwei.
    expect(wb.params.gas).toEqual({
      gasLimit: '100000',
      maxFeePerGas: ((251n * GWEI) / 10n).toString(),
      maxPriorityFeePerGas: ((11n * GWEI) / 10n).toString(),
      keyVersion: '1',
    });
    expect((await proveWithdraw(h, b.s, b.token, wb)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(b.s.swapId), { tx: txHex(wb.tx) }, b.token)).status).toBe(202);
    await tick(); // B signed at nonce 9 too, and is not mined either
    h.now.ms += 31 * 60_000;
    h.vault.evm.baseFee = 30n * GWEI; // B is stuck as well
    const wc = await paramsAndBuild(h, c.s, c.token, 'swap', 'c');
    expect(wc.evmNonce).toBe(9n);
    // Against the higher of A and B: tip 1.1 → ≥ 1.21, rounded up to 1.3 gwei; cap ≥ 27.61 and
    // 2 × 30 + 1.3 = 61.3 gwei.
    expect(wc.params.gas.maxPriorityFeePerGas).toBe(((13n * GWEI) / 10n).toString());
    expect(wc.params.gas.maxFeePerGas).toBe(((613n * GWEI) / 10n).toString());
    hold.open();
    await h.swaps.idle();
  });
});

// ── R3 ─────────────────────────────────────────────────────────────────────────

describe('R3: throttles replenish and never strand a funded swap', () => {
  it('a sponsor too low to pay refuses /prove withdraw BEFORE proving; after the refill the proof is there (probe N5)', async () => {
    const { s, token } = await takenSwap(h);
    h.sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 1n };
    const proved = h.prover.proved.length;
    for (let n = 0; n < 13; n++) {
      const w = withdrawFor(h, s, 'swap', { coinNonce: hex32(`t${n}`) });
      const res = await proveWithdraw(h, s, token, w);
      expect(res.status).toBe(503);
      expect((await errorOf(res)).code).toBe('sponsor-low');
    }
    expect(h.prover.proved).toHaveLength(proved);
    h.sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 10n ** 20n };
    const w = await paramsAndBuild(h, s, token, 'swap', 'after');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
  });

  it('a proven withdrawal refused at /withdraw for a transient reason gives its proof back, and can be sent again', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    expect(h.store.get(s.swapId)!.proofs.withdraw).toBe(1);
    h.sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 1n };
    const refused = await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
    expect(refused.status).toBe(503);
    expect(h.store.get(s.swapId)!.proofs.withdraw).toBe(0);
    h.sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 10n ** 20n };
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('done');
  });

  it('the per-swap proof budget comes back over 24 hours (Retry-After): no lifetime cap strands the funds', async () => {
    const hh = harness({ config: testConfig({ ...LIMITS, SWAP_PROOFS_TOTAL_PER_SWAP: '3' }) });
    vaultReady(hh);
    const { s, token } = await takenSwap(hh); // 1 proof (the take)
    for (let n = 0; n < 2; n++) {
      const w = await paramsAndBuild(hh, s, token, 'swap', `r${n}`);
      expect((await proveWithdraw(hh, s, token, w)).status).toBe(200);
      hh.vault.version++; // the vault moves: the start is refused at the head of the lane (a new attempt)
      await post(hh, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
      await hh.swaps.idle();
    }
    const w = await paramsAndBuild(hh, s, token, 'swap', 'r3');
    const spent = await proveWithdraw(hh, s, token, w);
    expect(spent.status).toBe(429);
    expect((await errorOf(spent)).code).toBe('proof-budget');
    expect(Number(spent.headers.get('retry-after'))).toBeGreaterThan(80_000);
    hh.now.ms += 86_400_000 + 1_000;
    const w2 = await paramsAndBuild(hh, s, token, 'swap', 'r4');
    expect((await proveWithdraw(hh, s, token, w2)).status).toBe(200);
  });

  it('the take budget comes back over 24 hours too', async () => {
    const hh = harness({ config: testConfig({ ...LIMITS, SWAP_PROOFS_PER_SWAP: '2' }) });
    vaultReady(hh);
    const m = await mintedSwap(hh);
    for (let n = 0; n < 2; n++)
      expect((await post(hh, SWAP_PATHS.prove(m.s.swapId), takeBody(m.s), m.token)).status).toBe(200);
    expect((await post(hh, SWAP_PATHS.prove(m.s.swapId), takeBody(m.s), m.token)).status).toBe(429);
    hh.now.ms += 86_400_000 + 1_000;
    expect((await post(hh, SWAP_PATHS.prove(m.s.swapId), takeBody(m.s), m.token)).status).toBe(200);
  });

  it('failed prover work counts in the daily budget: it is not given back for free (F-B27)', async () => {
    const hh = harness({ config: testConfig({ ...LIMITS, SWAP_PROOFS_TOTAL_PER_SWAP: '2' }) });
    vaultReady(hh);
    const m = await mintedSwap(hh);
    hh.prover.prove = async () => {
      throw new Error('the proof failed');
    };
    for (let n = 0; n < 2; n++)
      expect((await post(hh, SWAP_PATHS.prove(m.s.swapId), takeBody(m.s), m.token)).status).toBe(503);
    expect(hh.store.get(m.s.swapId)!.proofs.log!.filter((e) => e.failed)).toHaveLength(2);
    expect((await post(hh, SWAP_PATHS.prove(m.s.swapId), takeBody(m.s), m.token)).status).toBe(429);
  });

  it('a failed deposit stays recoverable past the per-day re-arms: the answer says when (retryAt), then it re-arms', async () => {
    const hh = harness({
      config: testConfig({
        ...LIMITS,
        DEPOSIT_MAX_ATTEMPTS: '1',
        DEPOSIT_MAX_REARMS: '1',
        DEPOSIT_REARM_COOLDOWN_SECONDS: '0',
      }),
    });
    const s = bidSwap(hh);
    const o = await openSwap(hh, s);
    fund(hh, o);
    hh.vault.defaultRelay = { kind: 'returned-false' };
    await hh.swaps.pollDeposits();
    await hh.swaps.idle();
    expect(hh.store.get(s.swapId)!).toMatchObject({
      state: 'failed',
      reason: 'deposit-returned-false',
      recoverable: true,
    });
    const r1 = await post(hh, SWAP_PATHS.swaps, await openBody(hh, s)); // re-arm 1 of the day
    const t1 = ((await r1.json()) as { swapToken: string }).swapToken;
    await hh.swaps.pollDeposits();
    await hh.swaps.idle();
    const v = await view(hh, s, t1);
    expect(v).toMatchObject({ state: 'failed', reason: 'deposit-returned-false', recoverable: true });
    const r2 = await post(hh, SWAP_PATHS.swaps, await openBody(hh, s)); // paced: not today
    expect(r2.status).toBe(200);
    const v2 = ((await r2.json()) as { swap: SwapView }).swap;
    expect(v2).toMatchObject({ state: 'failed', recoverable: true });
    expect(v2.retryAt).toBeGreaterThan(Math.floor(hh.now.ms / 1000) + 80_000);
    hh.now.ms += 86_400_000 + 1_000;
    hh.vault.defaultRelay = {};
    await post(hh, SWAP_PATHS.swaps, await openBody(hh, s));
    await hh.swaps.pollDeposits();
    await hh.swaps.idle();
    expect(hh.store.get(s.swapId)!.state).toBe('minted');
  });

  it('records written before this fix are migrated: a legacy failed deposit (no `recoverable`, or false from the old cap) revives', async () => {
    const store = new MemorySwapStore();
    const h1 = harness({ config: testConfig(LIMITS), store });
    const a = bidSwap(h1, undefined, 'legacy-a');
    const b = bidSwap(h1, undefined, 'legacy-b');
    for (const s of [a, b]) {
      const o = await openSwap(h1, s);
      fund(h1, o);
    }
    for (const s of [a, b]) {
      const rec = store.get(s.swapId)!;
      transition(rec, 'failed', rec.updatedAt, { reason: 'deposit-attempts', message: 'legacy' });
      if (s === a) delete rec.recoverable;
      else rec.recoverable = false;
      store.put(rec);
    }
    const h2 = harness({ config: testConfig(LIMITS), store, vault: h1.vault, offers: h1.offers });
    for (const s of [a, b]) {
      expect(store.get(s.swapId)!.recoverable).toBe(true);
      const res = await post(h2, SWAP_PATHS.swaps, await openBody(h2, s));
      expect(res.status).toBe(200);
      expect(store.get(s.swapId)!.state).toBe('awaiting_funds');
    }
  });
});

// ── R4 ─────────────────────────────────────────────────────────────────────────

describe('R4: unfunded opens cannot monopolise the caps or the budget; revival is admitted; reads cannot reset the poll', () => {
  it('about 100 unfunded opens commit no DUST: an honest new swap and a stranded deposit’s re-arm still go through (probe N1)', async () => {
    const hh = harness({ config: testConfig({ ...LIMITS, SWAP_MAX_UNFUNDED_PER_CLIENT: '1000' }) });
    const victim = bidSwap(hh, Wallet.createRandom(), 'victim');
    const vo = await openSwap(hh, victim);
    fund(hh, vo);
    hh.vault.defaultRelay = { kind: 'never-executed' };
    for (let i = 0; i < 4; i++) {
      await hh.swaps.pollDeposits();
      await hh.swaps.idle();
    }
    hh.vault.defaultRelay = {};
    expect(hh.store.get(victim.swapId)!).toMatchObject({ state: 'failed', reason: 'deposit-attempts' });
    let opened = 0;
    for (let i = 0; i < 97; i++) {
      const res = await post(hh, SWAP_PATHS.swaps, await openBody(hh, bidSwap(hh, Wallet.createRandom(), `spam-${i}`)));
      if (res.status === 201) opened++;
    }
    expect(opened).toBe(97);
    expect(hh.swaps.budgetStatus().exhausted).toBe(false);
    const honest = await post(hh, SWAP_PATHS.swaps, await openBody(hh, bidSwap(hh, Wallet.createRandom(), 'honest')));
    expect(honest.status).toBe(201);
    await post(hh, SWAP_PATHS.swaps, await openBody(hh, victim));
    expect(hh.store.get(victim.swapId)!.state).toBe('awaiting_funds');
  });

  it('an open needs the owner to hold the pay amount and the sweep ETH on Sepolia (read once per 30 s)', async () => {
    const s = bidSwap(h);
    const noToken = await post(h, SWAP_PATHS.swaps, await openBody(h, s, { ownerUnfunded: true }));
    expect(noToken.status).toBe(422);
    expect(await errorOf(noToken)).toMatchObject({ code: 'insufficient-funds', detail: 'token' });
    h.vault.evm.setErc20(BID.pay.token.sepoliaAddress, s.user.address, BID.pay.amount);
    h.now.ms += 31_000; // past the cache
    const noEth = await post(h, SWAP_PATHS.swaps, await openBody(h, s, { ownerUnfunded: true }));
    expect(await errorOf(noEth)).toMatchObject({ code: 'insufficient-funds', detail: 'eth' });
    let reads = 0;
    const tb = h.vault.evm.erc20Balance.bind(h.vault.evm);
    h.vault.evm.erc20Balance = async (t: string, a: string) => (reads++, tb(t, a));
    h.vault.evm.setEth(s.user.address, 10n ** 18n);
    await post(h, SWAP_PATHS.swaps, await openBody(h, s, { ownerUnfunded: true })); // cached token read: still eth-less?
    expect(reads).toBe(0);
    h.now.ms += 31_000;
    expect((await post(h, SWAP_PATHS.swaps, await openBody(h, s, { ownerUnfunded: true }))).status).toBe(201);
    expect(reads).toBe(1);
  });

  it('unfunded swaps are capped per client: an IPv4 address, or an IPv6 /48 (since P4.2-fix3, audit S5)', async () => {
    const client = { address: '203.0.113.9' };
    const hh = harness({ config: testConfig({ ...LIMITS, SWAP_MAX_UNFUNDED_PER_CLIENT: '2' }), client });
    const open = async (tag: string) => post(hh, SWAP_PATHS.swaps, await openBody(hh, bidSwap(hh, undefined, tag)));
    expect((await open('c1')).status).toBe(201);
    expect((await open('c2')).status).toBe(201);
    const third = await open('c3');
    expect(third.status).toBe(429);
    expect(await errorOf(third)).toMatchObject({ code: 'too-many-swaps', detail: 'client' });
    client.address = '2001:db8:1:2::1';
    expect((await open('v6-1')).status).toBe(201);
    client.address = '2001:db8:1:3:ffff::9'; // another /64 of the same /48
    expect((await open('v6-2')).status).toBe(201);
    client.address = '2001:db8:1:4:aaaa:bbbb:cccc:dddd';
    expect((await open('v6-3')).status).toBe(429);
    client.address = '2001:db8:2:3::1'; // another /48
    expect((await open('v6-4')).status).toBe(201);
  });

  it('reviving an expired unfunded swap passes the same admission as a new open (the global cap; the owner’s funds)', async () => {
    const hh = harness({ config: testConfig({ ...LIMITS, SWAP_MAX_UNFUNDED: '2' }) });
    const a = bidSwap(hh, undefined, 'rev-a');
    const b = bidSwap(hh, undefined, 'rev-b');
    const c = bidSwap(hh, undefined, 'rev-c');
    const d = bidSwap(hh, undefined, 'rev-d');
    hh.offers.add({
      offerId: BID.offerId,
      give: { colour: BID.receive.token.midnightColour, amount: BID.receive.amount },
      want: { colour: BID.pay.token.midnightColour, amount: BID.pay.amount },
      expiresInSeconds: 4 * 86_400, // still live after the 3 h the test waits
    });
    await openSwap(hh, a);
    await openSwap(hh, b);
    await hh.swaps.pollDeposits();
    hh.now.ms += 3 * 3_600_000 + 1_000;
    await hh.swaps.pollDeposits();
    expect(hh.store.get(a.swapId)!).toMatchObject({ state: 'failed', reason: 'funds-not-received', recoverable: true });
    await openSwap(hh, c);
    await openSwap(hh, d);
    const revive = await post(hh, SWAP_PATHS.swaps, await openBody(hh, a));
    expect(revive.status).toBe(503);
    expect((await errorOf(revive)).code).toBe('sponsor-busy');
    expect(hh.store.get(a.swapId)!.state).toBe('failed');
    // Part of the funds (one base unit) is still an unfunded swap: the same admission (audit S5).
    const ra = hh.store.get(a.swapId)!;
    hh.vault.evm.setErc20(ra.pay.erc20Address, ra.depositAddress, 1n);
    expect((await post(hh, SWAP_PATHS.swaps, await openBody(hh, a))).status).toBe(503);
    // A swap whose WHOLE pay amount arrived is not new work: it revives whatever the caps.
    hh.vault.evm.setErc20(ra.pay.erc20Address, ra.depositAddress, BigInt(ra.pay.amount));
    expect((await post(hh, SWAP_PATHS.swaps, await openBody(hh, a))).status).toBe(200);
    expect(hh.store.get(a.swapId)!.state).toBe('awaiting_funds');
  });

  it('page reads cannot reset the deposit poll’s backoff (at most one read a minute), and a pass reads a bounded number', async () => {
    const hh = harness({
      config: testConfig({ ...LIMITS, DEPOSIT_POLL_MAX_READS: '5', SWAP_MAX_UNFUNDED_PER_CLIENT: '1000' }),
    });
    const opened: { s: SwapInput; token: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const s = bidSwap(hh, undefined, `poll-${i}`);
      opened.push({ s, token: (await openSwap(hh, s)).swapToken });
    }
    let reads = 0;
    const seen = new Set<string>();
    const tb = hh.vault.evm.erc20Balance.bind(hh.vault.evm);
    hh.vault.evm.erc20Balance = async (t: string, a: string) => (reads++, seen.add(a.toLowerCase()), tb(t, a));
    for (let pass = 1; pass <= 3; pass++) {
      await hh.swaps.pollDeposits();
      expect(reads).toBe(5 * pass); // the pass budget
    }
    expect(seen.size).toBe(12); // the longest due first: every address was read within three passes
    hh.now.ms += 2 * 3_600_000; // the slow tier: one read per 5 minutes
    await hh.swaps.pollDeposits();
    await hh.swaps.pollDeposits();
    await hh.swaps.pollDeposits();
    reads = 0;
    const one = opened[0]!;
    for (let i = 0; i < 10; i++) {
      for (let k = 0; k < 5; k++) await get(hh, SWAP_PATHS.swap(one.s.swapId), one.token);
      hh.now.ms += 15_000;
      await hh.swaps.pollDeposits();
    }
    // 150 s of a page reading the swap five times per 15 s pass: at most one read a minute (3), not 10.
    expect(reads).toBeLessThanOrEqual(3);
  });
});

// ── R5 ─────────────────────────────────────────────────────────────────────────

describe('R5: an uncertain submission keeps its nonce until its request id settles it', () => {
  it('an error with the request not visible keeps the swap waiting and the nonce reserved; the next withdrawal signs the next nonce', async () => {
    const a = await takenSwap(h, bidSwap(h, undefined, 'A'));
    const b = await takenSwap(h, bidSwap(h, undefined, 'B'));
    const wa = await paramsAndBuild(h, a.s, a.token, 'swap', 'a');
    await proveWithdraw(h, a.s, a.token, wa);
    h.vault.submitFailure = 'lost';
    expect((await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token)).status).toBe(202);
    await h.swaps.idle();
    const ra = h.store.get(a.s.swapId)!;
    expect(ra.state).toBe('withdrawing');
    expect(ra.withdrawals.at(-1)!.stage).toBe('submission-uncertain');
    expect((await view(h, a.s, a.token)).withdrawal).toEqual({ attempts: 1, last: null, retry: false });
    expect(h.swaps.reservationsStatus()).toMatchObject([{ nonce: '9', uncertain: true, stuck: false }]);
    const wb = await paramsAndBuild(h, b.s, b.token, 'swap', 'b');
    expect(wb.evmNonce).toBe(10n);
  });

  it('it landed after all: the closer adopts it and drives it to its settle', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    await proveWithdraw(h, s, token, w);
    h.vault.submitFailure = 'lost-landed';
    const open = h.vault.openRequests.bind(h.vault);
    let lagging = true;
    h.vault.openRequests = async (k) =>
      lagging ? { ids: [], pathOf: () => undefined, detailOf: () => undefined } : open(k);
    await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.withdrawals.at(-1)!.stage).toBe('submission-uncertain');
    lagging = false; // the indexer caught up
    await closer(h).scan();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!).toMatchObject({ state: 'done', outcome: 'swapped' });
  });

  it('not in the vault and not attested long after it was sent: not included; the swap may retry on the same nonce', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    await proveWithdraw(h, s, token, w);
    h.vault.submitFailure = 'lost';
    await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
    await h.swaps.idle();
    await closer(h).scan(); // too early: still uncertain
    expect(h.store.get(s.swapId)!.withdrawals.at(-1)!.stage).toBe('submission-uncertain');
    h.now.ms += 16 * 60_000;
    await closer(h).scan();
    await h.swaps.idle();
    const v = await view(h, s, token);
    expect(v.state).toBe('minted');
    expect(v.withdraw!.error!.code).toBe('not-included');
    expect(v.withdrawal).toEqual({ attempts: 1, last: 'start-failed', retry: true });
    const retry = await paramsAndBuild(h, s, token, 'swap', 'retry');
    expect(retry.evmNonce).toBe(9n);
  });

  it('a superseded attempt recorded as failed before this fix blocks retries until it is settled, and is adopted if it landed', async () => {
    const store = new MemorySwapStore();
    const h1 = harness({ config: testConfig(LIMITS), store });
    vaultReady(h1);
    const { s, token } = await takenSwap(h1);
    const w = await paramsAndBuild(h1, s, token, 'swap');
    await proveWithdraw(h1, s, token, w);
    h1.vault.submitFailure = 'lost';
    await post(h1, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
    await h1.swaps.idle();
    // As b6b5347 recorded it: the attempt failed, the swap back to minted, no resolution ...
    const rec = store.get(s.swapId)!;
    const att = rec.withdrawals.at(-1)!;
    // ... but the start landed after all.
    h1.vault.requests.set(att.requestId!, {
      kind: 'withdraw',
      id: att.requestId!,
      path: 'vault',
      evmNonce: w.evmNonce,
      signer: VAULT_EVM,
      erc20: tok('USDC').sepoliaAddress,
      amount: BID.receive.amount,
      gasLimit: 100_000n,
      maxFeePerGas: 10n * GWEI,
    });
    att.stage = 'failed';
    att.error = { code: 'internal-error', message: 'the node timed out' };
    delete att.uncertainSinceMs;
    transition(rec, 'minted', rec.updatedAt);
    store.put(rec);
    const h2 = harness({ config: testConfig(LIMITS), store, vault: h1.vault, offers: h1.offers });
    h2.now.ms = h1.now.ms;
    expect(store.get(s.swapId)!.withdrawals.at(-1)!.unresolved).toBe(true);
    const retry = await get(h2, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=swap`, token);
    expect(retry.status).toBe(409);
    expect(await errorOf(retry)).toMatchObject({ code: 'withdrawal-in-progress', detail: 'adopted' });
    await h2.swaps.idle();
    expect(store.get(s.swapId)!).toMatchObject({ state: 'done', outcome: 'swapped' });
    expect(h1.vault.startNonces.filter((x) => x.kind === 'withdraw')).toHaveLength(0); // no second start
  });

  it('a node that reports FailEntirely, or a DUST balancing that never reached the node, is conclusive', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    await proveWithdraw(h, s, token, w);
    h.vault.submitFailure = 'not-submitted';
    await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
    await h.swaps.idle();
    expect((await view(h, s, token)).withdrawal).toEqual({ attempts: 1, last: 'start-failed', retry: true });
    expect(h.store.get(s.swapId)!.withdrawals.at(-1)!.resolution).toBe('not-submitted');
  });
});

// ── R6 ─────────────────────────────────────────────────────────────────────────

describe('R6: deposit adoption needs the sponsor’s own parameters; a request that swept the deposit is completed', () => {
  it('a foreign request with the right token and amount but another nonce and an unpayable fee is not adopted (probe N2)', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    h.vault.defaultRelay = { kind: 'never-executed' };
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    h.vault.defaultRelay = {};
    const foreign = await h.vault.startDeposit({
      recipientCoinPk: s.payload.tempCoinPk,
      erc20: o.erc20Address,
      amount: BigInt(o.amount),
      gas: { gasLimit: 21_000n, maxFeePerGas: 900n * GWEI, maxPriorityFeePerGas: 900n * GWEI, keyVersion: 1n },
      evmNonce: 7n,
    });
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const d = h.store.get(s.swapId)!.deposit!;
    expect(d.requestId).not.toBe(foreign.requestId);
    expect(h.store.get(s.swapId)!.state).toBe('minted'); // through its own new start
  });

  it('the sponsor’s own request (its parameters) is adopted after a crash lost its id', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    const own = await h.vault.startDeposit({
      recipientCoinPk: s.payload.tempCoinPk,
      erc20: o.erc20Address,
      amount: BigInt(o.amount),
      gas: {
        gasLimit: BigInt(o.sweepGas.gasLimit),
        maxFeePerGas: BigInt(o.sweepGas.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(o.sweepGas.maxPriorityFeePerGas),
        keyVersion: 1n,
      },
      evmNonce: 0n,
    });
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.deposit!.requestId).toBe(own.requestId);
    expect(rec.deposit!.stages.map((x) => x.stage)).toContain('adopted');
    expect(rec.state).toBe('minted');
  });

  it('a foreign full-amount request that won the sweep is completed by the sponsor: the swap mints (probe N2b)', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    const hold = gate();
    h.vault.defaultRelay = { kind: 'never-executed', beforeBroadcast: hold.promise };
    await h.swaps.pollDeposits();
    await tick();
    const foreign = await h.vault.startDeposit({
      recipientCoinPk: s.payload.tempCoinPk,
      erc20: o.erc20Address,
      amount: BigInt(o.amount),
      gas: { gasLimit: 65_000n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: 2n * GWEI, keyVersion: 1n },
      evmNonce: 0n,
    });
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, 0n); // swept by the foreign request
    h.vault.attestations.set(foreign.requestId, 'success');
    hold.open(); // the sponsor's own sweep: never executed (its nonce was consumed)
    await h.swaps.idle();
    h.vault.defaultRelay = {};
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('minted');
    expect(rec.deposit!.requestId).toBe(foreign.requestId);
    expect(h.vault.settles.at(-1)).toMatchObject({
      circuit: 'completeDeposit',
      requestId: foreign.requestId,
      coinPk: s.payload.tempCoinPk,
      encPk: s.payload.tempEncPk,
    });
  });

  it('a foreign request for another amount that swept part of the deposit is completed too (the coin reaches the temporary wallet; since P4.2-fix3 the swap is partial)', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, 10n); // part of the token arrived
    await h.swaps.pollDeposits();
    const foreign = await h.vault.startDeposit({
      recipientCoinPk: s.payload.tempCoinPk,
      erc20: o.erc20Address,
      amount: 4n,
      gas: { gasLimit: 65_000n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: 2n * GWEI, keyVersion: 1n },
      evmNonce: 0n,
    });
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, 6n);
    h.vault.attestations.set(foreign.requestId, 'success');
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('partial');
    expect(rec.deposit!.foreign).toMatchObject([{ requestId: foreign.requestId, amount: '4' }]);
    expect(rec.deposit!.stages.map((x) => x.stage)).toContain('completed-foreign');
    expect(rec.deposit!.stage).toBe('partial');
    expect(h.vault.settles.at(-1)).toMatchObject({ circuit: 'completeDeposit', coinPk: s.payload.tempCoinPk });
  });
});

describe('the harness funds owners (R4 checks it)', () => {
  it('fundOwner gives the owner the pay amount and 1 ETH', () => {
    const s = bidSwap(h);
    fundOwner(h, s);
    expect(h.vault.evm.erc20.get(`${BID.pay.token.sepoliaAddress.toLowerCase()}/${s.user.address.toLowerCase()}`)).toBe(
      BID.pay.amount,
    );
  });
});

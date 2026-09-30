// The P4.2 security fix pass, sponsor side (plan 00048 P4.2-fix, lane FS; audit
// audits/00048-evm-midnight-transparent-security.md, Consolidation rows C1–C16). Each describe block
// names its row; each test failed before its fix (several started from auditor A's probes,
// evidence/00048-evm-midnight-transparent/p4-audit/probes-a/audit-a.test.ts).

import { SWAP_PATHS, SwapViewSchema, type SwapView } from '@evm-midnight-transparent/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { StaleCloser } from '../src/swaps/stale.js';
import { VAULT_EVM, gate, summaryWith } from './fakes.js';
import {
  BID,
  bidSwap,
  bidTake,
  fund,
  get,
  harness,
  hex32,
  mintedSwap,
  openBody,
  openSwap,
  post,
  testConfig,
  tok,
  txHex,
  withdrawFor,
  type Harness,
  type SwapInput,
} from './harness.js';

const view = async (h: Harness, s: SwapInput, token: string): Promise<SwapView> => {
  const body = (await (await get(h, SWAP_PATHS.swap(s.swapId), token)).json()) as { swap: unknown };
  return SwapViewSchema.parse(body.swap);
};

const proveWithdraw = (
  h: Harness,
  s: SwapInput,
  token: string,
  w: { tx: Parameters<typeof txHex>[0]; coinNonce: string; evmNonce: bigint },
  kind?: 'swap' | 'bridge-back',
) =>
  post(
    h,
    SWAP_PATHS.prove(s.swapId),
    {
      purpose: 'withdraw',
      tx: txHex(w.tx),
      coinNonce: w.coinNonce,
      evmNonce: w.evmNonce.toString(),
      ...(kind ? { kind } : {}),
    },
    token,
  );

async function takenSwap(h: Harness, s: SwapInput = bidSwap(h)) {
  const m = await mintedSwap(h, s);
  expect((await post(h, SWAP_PATHS.prove(s.swapId), { purpose: 'take', tx: txHex(bidTake()) }, m.token)).status).toBe(
    200,
  );
  expect((await post(h, SWAP_PATHS.take(s.swapId), { outcome: 'taken', takeTx: hex32('take') }, m.token)).status).toBe(
    200,
  );
  return m;
}

/** withdraw-params, then the browser's build on them. */
async function paramsAndBuild(h: Harness, s: SwapInput, token: string, kind: 'swap' | 'bridge-back', tag = 'c') {
  const res = await get(h, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=${kind}`, token);
  expect(res.status).toBe(200);
  const p = (await res.json()) as { evmNonce: string; gas: { maxFeePerGas: string } };
  return withdrawFor(h, s, kind, {
    evmNonce: BigInt(p.evmNonce),
    coinNonce: hex32(`${tag}-${p.evmNonce}`),
    maxFeePerGas: BigInt(p.gas.maxFeePerGas),
  });
}

let h: Harness;
beforeEach(() => {
  h = harness({
    config: testConfig({ RATE_LIMIT_PROVES_PER_SWAP_PER_MIN: '1000', RATE_LIMIT_PROVES_PER_MIN: '1000' }),
  });
  h.vault.evm.nonces.set(VAULT_EVM.toLowerCase(), { latest: 9n, pending: 9n });
  h.vault.evm.setEth(VAULT_EVM, 10n ** 17n);
  for (const t of [tok('stkA'), tok('USDC')]) h.vault.evm.setErc20(t.sepoliaAddress, VAULT_EVM, 10n ** 12n);
});

// ── C1 ─────────────────────────────────────────────────────────────────────────

describe('C1 (sponsor side): the swap view says when the page must rebuild and retry the withdrawal', () => {
  it('after a refund: withdrawal {attempts 1, last refunded, retry true}, and the refund counts itself', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    h.vault.defaultRelay = { kind: 'never-executed' };
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
    const v = await view(h, s, token);
    expect(v.state).toBe('minted');
    expect(v.withdrawal).toEqual({ attempts: 1, last: 'refunded', retry: true });
    expect(v.withdraw!.refunds).toBe(1);
    expect(v.withdrawals.map((x) => x.refunds)).toEqual([1]);

    // The retry: in flight → no retry; done → no retry; the refund count carries over.
    h.vault.defaultRelay = {};
    const w2 = await paramsAndBuild(h, s, token, 'swap', 'retry');
    expect((await proveWithdraw(h, s, token, w2)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w2.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
    const done = await view(h, s, token);
    expect(done.state).toBe('done');
    expect(done.withdrawal).toEqual({ attempts: 2, last: null, retry: false });
    expect(done.withdrawals.map((x) => x.refunds)).toEqual([1, 1]);
  });

  it('after a start refused at the head of the lane because the vault moved: last stale-vault, retry true', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    h.vault.version++; // another vault request landed between /prove and the head of the lane
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
    const v = await view(h, s, token);
    expect(v.state).toBe('minted');
    expect(v.withdrawal).toEqual({ attempts: 1, last: 'stale-vault', retry: true });
  });

  it('after a start that failed for another reason (a stale EVM nonce): last start-failed, retry true', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    h.vault.evm.bumpNonce(VAULT_EVM); // another service's transfer took the nonce
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
    const v = await view(h, s, token);
    expect(v.withdrawal).toEqual({ attempts: 1, last: 'start-failed', retry: true });
    expect(v.withdraw!.error!.code).toBe('stale-evm-nonce');
  });

  it('before any withdrawal: {attempts 0, last null, retry false}', async () => {
    const m = await mintedSwap(h);
    expect((await view(h, m.s, m.token)).withdrawal).toEqual({ attempts: 0, last: null, retry: false });
  });
});

// ── C5 ─────────────────────────────────────────────────────────────────────────

describe('C5 (sponsor side): a funded deposit never fails by age, and failed deposits are recoverable', () => {
  it('a FUNDED swap the sponsor could not start for a day stays awaiting_funds (the balance is read first)', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    h.sponsor.current = { configured: true, state: 'syncing', synced: false, dustSpecks: 10n ** 20n };
    await h.swaps.pollDeposits();
    h.now.ms += 86_401_000;
    await h.swaps.pollDeposits();
    expect(h.store.get(s.swapId)!.state).toBe('awaiting_funds');
    h.sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 10n ** 20n };
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('minted');
  });

  it('an unfunded swap fails as funds-not-received, recoverable; a re-open revives it', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    h.now.ms += 86_401_000;
    await h.swaps.pollDeposits();
    const v = await view(h, s, o.swapToken);
    expect(v).toMatchObject({ state: 'failed', reason: 'funds-not-received', recoverable: true });
    const again = await post(h, SWAP_PATHS.swaps, await openBody(h, s));
    expect(again.status).toBe(200);
    expect(h.store.get(s.swapId)!.state).toBe('awaiting_funds');
  });

  it('deposit-attempts (every sweep never executed) is recoverable: a re-open re-arms a new startDeposit to the same recipient', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    h.vault.defaultRelay = { kind: 'never-executed' };
    for (let i = 0; i < 4; i++) {
      await h.swaps.pollDeposits();
      await h.swaps.idle();
    }
    const failed = await view(h, s, o.swapToken);
    expect(failed).toMatchObject({ state: 'failed', reason: 'deposit-attempts', recoverable: true });
    h.vault.defaultRelay = {};
    const again = await post(h, SWAP_PATHS.swaps, await openBody(h, s));
    expect(again.status).toBe(200);
    const token = ((await again.json()) as { swapToken: string }).swapToken;
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const v = await view(h, s, token);
    expect(v.state).toBe('minted');
    const starts = h.vault.log.filter((l) => l.startsWith('startDeposit'));
    expect(starts).toHaveLength(4);
    expect(new Set(starts.map((l) => l.split(' ')[1]))).toEqual(new Set([s.payload.tempCoinPk.slice(0, 8)]));
  });

  it('deposit-returned-false is recoverable: a re-open starts a new deposit while the funds are at the address', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    h.vault.defaultRelay = { kind: 'returned-false' };
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect(await view(h, s, o.swapToken)).toMatchObject({
      state: 'failed',
      reason: 'deposit-returned-false',
      recoverable: true,
    });
    h.vault.defaultRelay = {};
    const again = await post(h, SWAP_PATHS.swaps, await openBody(h, s));
    const token = ((await again.json()) as { swapToken: string }).swapToken;
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect((await view(h, s, token)).state).toBe('minted');
  });

  it('re-arming is capped: after the last re-arm the failure is no longer recoverable', async () => {
    const hh = harness({ config: testConfig({ DEPOSIT_MAX_ATTEMPTS: '1', DEPOSIT_MAX_REARMS: '1' }) });
    const s = bidSwap(hh);
    const o = await openSwap(hh, s);
    fund(hh, o);
    hh.vault.defaultRelay = { kind: 'returned-false' };
    await hh.swaps.pollDeposits();
    await hh.swaps.idle();
    expect(hh.store.get(s.swapId)!).toMatchObject({ state: 'failed', reason: 'deposit-returned-false' });
    const r1 = await post(hh, SWAP_PATHS.swaps, await openBody(hh, s));
    const t1 = ((await r1.json()) as { swapToken: string }).swapToken;
    await hh.swaps.pollDeposits();
    await hh.swaps.idle();
    const v = await view(hh, s, t1);
    expect(v).toMatchObject({ state: 'failed', reason: 'deposit-returned-false', recoverable: false });
    await post(hh, SWAP_PATHS.swaps, await openBody(hh, s));
    expect(hh.store.get(s.swapId)!.state).toBe('failed');
  });
});

// ── C13 ────────────────────────────────────────────────────────────────────────

describe('C13: a "taken" report never blocks Bridge back (the coins decide)', () => {
  it('after a taken report the paid token can still be bridged back, and not-available returns to minted', async () => {
    const m = await mintedSwap(h);
    const { s, token } = m;
    expect((await post(h, SWAP_PATHS.take(s.swapId), { outcome: 'taken', takeTx: hex32('ghost') }, token)).status).toBe(
      200,
    );
    const params = await get(h, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=bridge-back`, token);
    expect(params.status).toBe(200);
    expect(((await params.json()) as { colour: string }).colour).toBe(BID.pay.token.midnightColour);
    const na = await post(h, SWAP_PATHS.take(s.swapId), { outcome: 'not-available' }, token);
    expect(na.status).toBe(200);
    expect(h.store.get(s.swapId)!.state).toBe('minted');
  });

  it('a Bridge back proven and submitted after a mistaken taken report completes', async () => {
    const m = await mintedSwap(h);
    const { s, token } = m;
    await post(h, SWAP_PATHS.take(s.swapId), { outcome: 'taken', takeTx: hex32('ghost') }, token);
    const w = await paramsAndBuild(h, s, token, 'bridge-back');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!).toMatchObject({ state: 'done', outcome: 'bridged-back' });
  });
});

// ── C11 ────────────────────────────────────────────────────────────────────────

describe('C11: proof budgets reset on progress, admission is atomic, a moved vault answers 409', () => {
  it('twelve stale-vault rounds no longer exhaust the withdraw proofs: each failed start gives the next attempt a fresh budget', async () => {
    const { s, token } = await takenSwap(h);
    for (let i = 0; i < 12; i++) {
      const w = await paramsAndBuild(h, s, token, 'swap', `round${i}`);
      expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
      h.vault.version++; // someone else's deposit or withdrawal landed in between
      expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token)).status).toBe(202);
      await h.swaps.idle();
    }
    const w = await paramsAndBuild(h, s, token, 'swap', 'last');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
  });

  it('a lifetime cap still bounds the proofs of one swap', async () => {
    const hh = harness({
      config: testConfig({
        RATE_LIMIT_PROVES_PER_SWAP_PER_MIN: '1000',
        RATE_LIMIT_PROVES_PER_MIN: '1000',
        SWAP_PROOFS_TOTAL_PER_SWAP: '4',
      }),
    });
    hh.vault.evm.nonces.set(VAULT_EVM.toLowerCase(), { latest: 9n, pending: 9n });
    hh.vault.evm.setEth(VAULT_EVM, 10n ** 17n);
    hh.vault.evm.setErc20(tok('USDC').sepoliaAddress, VAULT_EVM, 10n ** 12n);
    const { s, token } = await takenSwap(hh); // one take proof
    for (let i = 0; i < 3; i++) {
      const w = await paramsAndBuild(hh, s, token, 'swap', `r${i}`);
      expect((await proveWithdraw(hh, s, token, w)).status).toBe(200);
      hh.vault.version++;
      await post(hh, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
      await hh.swaps.idle();
    }
    const w = await paramsAndBuild(hh, s, token, 'swap', 'over');
    const res = await proveWithdraw(hh, s, token, w);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('proof-budget');
  });

  it('/prove on a vault that moved after withdraw-params answers 409 stale-vault-state (rebuild); a wrong call on an unmoved vault stays 422', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    h.vault.version++; // a vault request landed after the browser built on its block
    const moved = await proveWithdraw(h, s, token, w);
    expect(moved.status).toBe(409);
    expect(((await moved.json()) as { error: { code: string } }).error.code).toBe('stale-vault-state');
    const w2 = await paramsAndBuild(h, s, token, 'swap', 'second');
    const wrong = withdrawFor(h, s, 'swap', {
      evmNonce: w2.evmNonce,
      coinNonce: w2.coinNonce,
      dest: '0x000000000000000000000000000000000000dEaD',
    });
    const res = await proveWithdraw(h, s, token, wrong);
    expect(res.status).toBe(422);
    expect(h.store.get(s.swapId)!.proofs.withdraw).toBe(0);
  });

  it('concurrent opens with one temporary coin key admit exactly one swap', async () => {
    const slow = h.offers.offer.bind(h.offers);
    h.offers.offer = async (id: string) => {
      await new Promise((r) => setTimeout(r, 15));
      return slow(id);
    };
    const base = bidSwap(h);
    const bodies = await Promise.all([0, 1, 2, 3, 4].map((i) => openBody(h, { ...base, swapId: hex32(`race-${i}`) })));
    const res = await Promise.all(bodies.map((b) => post(h, SWAP_PATHS.swaps, b)));
    expect(res.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    expect(h.store.all()).toHaveLength(1);
  });

  it('concurrent opens by one owner cannot pass the per-owner cap', async () => {
    const slow = h.offers.offer.bind(h.offers);
    h.offers.offer = async (id: string) => {
      await new Promise((r) => setTimeout(r, 15));
      return slow(id);
    };
    const base = bidSwap(h);
    const bodies = await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        openBody(h, {
          ...base,
          swapId: hex32(`own-${i}`),
          payload: { ...base.payload, tempCoinPk: hex32(`coin-own-${i}`), tempEncPk: hex32(`enc-own-${i}`) },
        }),
      ),
    );
    const res = await Promise.all(bodies.map((b) => post(h, SWAP_PATHS.swaps, b)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(h.config.swaps.maxActivePerOwner);
    expect(h.store.all()).toHaveLength(h.config.swaps.maxActivePerOwner);
  });

  it('concurrent proofs at the budget boundary never pass the budget', async () => {
    const hh = harness({
      config: testConfig({
        RATE_LIMIT_PROVES_PER_SWAP_PER_MIN: '1000',
        RATE_LIMIT_PROVES_PER_MIN: '1000',
        SWAP_PROOFS_PER_SWAP: '2',
      }),
    });
    const m = await mintedSwap(hh);
    const slow = hh.offers.status.bind(hh.offers);
    hh.offers.status = async (id: string) => {
      await new Promise((r) => setTimeout(r, 15));
      return slow(id);
    };
    const res = await Promise.all(
      [0, 1, 2, 3, 4].map(() =>
        post(hh, SWAP_PATHS.prove(m.s.swapId), { purpose: 'take', tx: txHex(bidTake()) }, m.token),
      ),
    );
    expect(res.filter((r) => r.status === 200)).toHaveLength(2);
    expect(hh.prover.proved).toHaveLength(2);
  });
});

// ── C16: F-A15 ────────────────────────────────────────────────────────────────

describe('C16 F-A15: /prove withdraw refuses an EVM nonce the lane can never reach', () => {
  it('a nonce far above the next one is refused (409 stale-evm-nonce) and costs no proof', async () => {
    const { s, token } = await takenSwap(h);
    const w = withdrawFor(h, s, 'swap', { evmNonce: 1_000_000n });
    const res = await proveWithdraw(h, s, token, w);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('stale-evm-nonce');
    expect(h.store.get(s.swapId)!.proofs.withdraw).toBe(0);
  });
});

// ── C6 ─────────────────────────────────────────────────────────────────────────

/** The per-IP limits out of the way: these tests open many swaps from one client address. */
const OPEN_LIMITS = { RATE_LIMIT_OPENS_PER_MIN: '1000', RATE_LIMIT_NONCES_PER_MIN: '1000' };

/** Open `n` unfunded swaps of the bid, each by a fresh EVM key (any key is free). */
async function openMany(hh: Harness, n: number, tag: string) {
  const out: { s: SwapInput; status: number; token?: string }[] = [];
  for (let i = 0; i < n; i++) {
    const s = bidSwap(hh, undefined, `${tag}-${i}`);
    const res = await post(hh, SWAP_PATHS.swaps, await openBody(hh, s));
    const body = (await res.json()) as { swapToken?: string; error?: { code: string } };
    out.push({ s, status: res.status, ...(body.swapToken ? { token: body.swapToken } : {}) });
  }
  return out;
}

/** Count the Sepolia reads the deposit poll makes. */
function countReads(hh: Harness) {
  const evm = hh.vault.evm;
  const n = { reads: 0 };
  const eb = evm.ethBalance.bind(evm);
  const tb = evm.erc20Balance.bind(evm);
  evm.ethBalance = async (a: string) => (n.reads++, eb(a));
  evm.erc20Balance = async (t: string, a: string) => (n.reads++, tb(t, a));
  return n;
}

describe('C6: unfunded-swap spam is capped, cheap to watch, short-lived and pruned', () => {
  it('a global cap on swaps waiting for funds: past it, new swaps get 503 sponsor-busy (re-opens still work)', async () => {
    const hh = harness({ config: testConfig({ ...OPEN_LIMITS, SWAP_MAX_UNFUNDED: '5' }) });
    const opened = await openMany(hh, 6, 'cap');
    expect(opened.map((o) => o.status)).toEqual([201, 201, 201, 201, 201, 503]);
    const again = await post(hh, SWAP_PATHS.swaps, await openBody(hh, opened[0]!.s));
    expect(again.status).toBe(200);
  });

  it('the watcher reads the token first, and backs off for swaps that received nothing', async () => {
    const hh = harness({ config: testConfig(OPEN_LIMITS) });
    await openMany(hh, 20, 'watch');
    const n = countReads(hh);
    await hh.swaps.pollDeposits();
    expect(n.reads).toBe(20); // one ERC20 read each; no ETH read while the token is short
    hh.now.ms += 2 * 3_600_000; // two hours in: nothing has arrived anywhere
    n.reads = 0;
    await hh.swaps.pollDeposits();
    expect(n.reads).toBe(20);
    hh.now.ms += 60_000;
    n.reads = 0;
    await hh.swaps.pollDeposits();
    expect(n.reads).toBe(0); // the next read is minutes away
  });

  it('a swap that received nothing fails after 3 h (recoverable); one with some of the token waits a day', async () => {
    const hh = harness({ config: testConfig(OPEN_LIMITS) });
    const [a, b] = await openMany(hh, 2, 'window');
    const rb = hh.store.get(b!.s.swapId)!;
    hh.vault.evm.setErc20(rb.pay.erc20Address, rb.depositAddress, 1n); // part of the token arrived
    await hh.swaps.pollDeposits();
    hh.now.ms += 3 * 3_600_000 + 1_000;
    await hh.swaps.pollDeposits();
    expect(hh.store.get(a!.s.swapId)!).toMatchObject({
      state: 'failed',
      reason: 'funds-not-received',
      recoverable: true,
    });
    expect(hh.store.get(b!.s.swapId)!.state).toBe('awaiting_funds');
  });

  it('never-funded failed swaps are pruned after SWAP_RETAIN_UNFUNDED_DAYS once their address is confirmed empty', async () => {
    const hh = harness({ config: testConfig(OPEN_LIMITS) });
    const [a, b] = await openMany(hh, 2, 'prune');
    hh.now.ms += 3 * 3_600_000 + 1_000;
    await hh.swaps.pollDeposits();
    expect(hh.store.get(a!.s.swapId)!.state).toBe('failed');
    const rb = hh.store.get(b!.s.swapId)!;
    hh.now.ms += 2 * 86_400_000 + 1_000;
    hh.vault.evm.setEth(rb.depositAddress, 1n); // someone sent to b's address after it failed
    await hh.swaps.pruneUnfunded();
    expect(hh.store.get(a!.s.swapId)).toBeUndefined();
    expect(hh.store.get(b!.s.swapId)).toBeDefined();
  });
});

// ── C7 ─────────────────────────────────────────────────────────────────────────

describe('C7: a sponsorship budget', () => {
  it('per-address daily swaps: the limit holds even when the earlier swaps have ended', async () => {
    const hh = harness({ config: testConfig({ ...OPEN_LIMITS, SWAP_MAX_PER_OWNER_PER_DAY: '2' }) });
    const user = bidSwap(hh).user;
    for (const tag of ['d1', 'd2']) await openSwap(hh, bidSwap(hh, user, tag));
    hh.now.ms += 3 * 3_600_000 + 1_000;
    await hh.swaps.pollDeposits(); // both fail: nothing is active any more
    const res = await post(hh, SWAP_PATHS.swaps, await openBody(hh, bidSwap(hh, user, 'd3')));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('too-many-swaps');
    hh.now.ms += 86_400_000;
    const s4 = bidSwap(hh, user, 'd4');
    // The fake book dates its offers by the real clock; this one must outlive the fake day.
    hh.offers.add({
      offerId: BID.offerId,
      give: { colour: BID.receive.token.midnightColour, amount: BID.receive.amount },
      want: { colour: BID.pay.token.midnightColour, amount: BID.pay.amount },
      expiresInSeconds: 4 * 86_400,
    });
    expect((await post(hh, SWAP_PATHS.swaps, await openBody(hh, s4))).status).toBe(201);
  });

  it('a daily DUST budget: new swaps are refused (503 sponsor-budget) once spent + committed legs would pass it', async () => {
    // 2.2 DUST per start and 0.4 per settle: a swap commits 5.2 DUST; a 12-DUST budget admits two.
    const hh = harness({ config: testConfig({ ...OPEN_LIMITS, SPONSOR_DAILY_DUST_BUDGET: '12' }) });
    const opened = await openMany(hh, 3, 'budget');
    expect(opened.map((o) => o.status)).toEqual([201, 201, 503]);
    const body = (await (
      await post(hh, SWAP_PATHS.swaps, await openBody(hh, bidSwap(hh, undefined, 'budget-x')))
    ).json()) as {
      error: { code: string };
    };
    expect(body.error.code).toBe('sponsor-budget');
    const st = hh.swaps.budgetStatus();
    expect(st).toMatchObject({
      dustBudgetSpecks24h: (12n * 10n ** 15n).toString(),
      exhausted: true,
      swapsOpened24h: 2,
    });
  });

  it('a deposit → Bridge back loop spends from the same budget: legs executed count for 24 h', async () => {
    const hh = harness({ config: testConfig({ ...OPEN_LIMITS, SPONSOR_DAILY_DUST_BUDGET: '12' }) });
    hh.vault.evm.nonces.set(VAULT_EVM.toLowerCase(), { latest: 9n, pending: 9n });
    hh.vault.evm.setEth(VAULT_EVM, 10n ** 17n);
    hh.vault.evm.setErc20(tok('stkA').sepoliaAddress, VAULT_EVM, 10n ** 12n);
    const m = await mintedSwap(hh, bidSwap(hh, undefined, 'loop'));
    const w = await paramsAndBuild(hh, m.s, m.token, 'bridge-back');
    expect((await proveWithdraw(hh, m.s, m.token, w)).status).toBe(200);
    expect((await post(hh, SWAP_PATHS.withdraw(m.s.swapId), { tx: txHex(w.tx) }, m.token)).status).toBe(202);
    await hh.swaps.idle();
    expect(hh.store.get(m.s.swapId)!.state).toBe('done');
    const st = hh.swaps.budgetStatus();
    expect(st.dustSpentSpecks24h).toBe((52n * 10n ** 14n).toString()); // 2 starts + 2 settles
    expect((await openMany(hh, 2, 'after-loop')).map((o) => o.status)).toEqual([201, 503]);
    hh.now.ms += 86_400_000 + 1_000;
    expect(hh.swaps.budgetStatus().dustSpentSpecks24h).toBe('0');
  });
});

// ── C12 ────────────────────────────────────────────────────────────────────────

describe('C12: the sponsor adopts only requests that are this swap’s, and adoption obeys the closer’s caps', () => {
  it('an attacker’s 1-unit startDeposit to the swap’s recipient is not adopted: the sponsor starts its own', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    const attacker = await h.vault.startDeposit({
      recipientCoinPk: s.payload.tempCoinPk,
      erc20: o.erc20Address,
      amount: 1n,
      gas: { gasLimit: 65_000n, maxFeePerGas: 9_000_000_000n, maxPriorityFeePerGas: 3_000_000_000n, keyVersion: 1n },
      evmNonce: 0n,
    });
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.deposit!.requestId).not.toBe(attacker.requestId);
    expect(rec.deposit!.stages.map((x) => x.stage)).not.toContain('adopted');
    expect(h.vault.log.filter((l) => l.startsWith('startDeposit'))).toHaveLength(2);
    expect(rec.state).toBe('minted');
  });

  it('nor one for another token of the same amount', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    const other = await h.vault.startDeposit({
      recipientCoinPk: s.payload.tempCoinPk,
      erc20: tok('stkB').sepoliaAddress,
      amount: BigInt(o.amount),
      gas: { gasLimit: 65_000n, maxFeePerGas: 2_500_000_000n, maxPriorityFeePerGas: 500_000_000n, keyVersion: 1n },
      evmNonce: 0n,
    });
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.deposit!.requestId).not.toBe(other.requestId);
  });

  it('a late withdrawal start is adopted only within the closer’s daily cap and DUST reserve, and counts as a spend', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    const submit = h.vault.submitWithdraw.bind(h.vault);
    h.vault.submitWithdraw = async () => {
      throw new Error('the node timed out');
    };
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
    const failed = h.store.get(s.swapId)!;
    expect(failed.state).toBe('minted');
    const requestId = failed.withdrawals.at(-1)!.requestId!;
    // ... but the start landed after all
    h.vault.submitWithdraw = submit;
    h.vault.requests.set(requestId, {
      kind: 'withdraw',
      id: requestId,
      path: 'vault',
      evmNonce: w.evmNonce,
      signer: VAULT_EVM,
      erc20: tok('USDC').sepoliaAddress,
      amount: BID.receive.amount,
      gasLimit: 100_000n,
      maxFeePerGas: 10_000_000_000n,
    });
    const closerWith = (maxPerDay: number, dust: bigint) =>
      new StaleCloser({
        config: { enabled: true, intervalMs: 1000, staleAfterMs: 900_000, maxPerDay, minSponsorDustSpecks: 10n ** 16n },
        service: h.swaps,
        sponsor: () => ({ configured: true, state: 'synced', synced: true, dustSpecks: dust }),
        log: h.log,
        now: () => h.now.ms,
      });
    const capped = closerWith(0, 10n ** 20n);
    await capped.scan();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('minted');
    expect(capped.status().paused).toMatch(/cap/);
    const poor = closerWith(5, 10n ** 15n);
    await poor.scan();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('minted');
    const ok = closerWith(5, 10n ** 20n);
    await ok.scan();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!).toMatchObject({ state: 'done', outcome: 'swapped' });
    expect(ok.status().closed24h).toBe(1);
  });
});

// ── C2 / C3 ────────────────────────────────────────────────────────────────────

const GWEI = 1_000_000_000n;
const tick = () => new Promise((r) => setTimeout(r, 20));

/** Two swaps that have taken their offer (A and B), ready to withdraw. */
async function twoTaken(hh: Harness) {
  const a = await takenSwap(hh, bidSwap(hh, undefined, 'A'));
  const b = await takenSwap(hh, bidSwap(hh, undefined, 'B'));
  return { a, b };
}

describe('C2: fees follow the live base fee, and a transfer that is never mined never holds the lane', () => {
  it('withdraw-params sizes the transfer’s fee from the live base fee: 2 × base + tip, at least 10 gwei, at most the cap', async () => {
    const { s, token } = await takenSwap(h);
    const params = async () => get(h, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=swap`, token);
    h.vault.evm.baseFee = 20n * GWEI;
    expect(((await (await params()).json()) as { gas: { maxFeePerGas: string } }).gas.maxFeePerGas).toBe(
      (41n * GWEI).toString(),
    );
    h.vault.evm.baseFee = 1n * GWEI;
    expect(((await (await params()).json()) as { gas: { maxFeePerGas: string } }).gas.maxFeePerGas).toBe(
      (10n * GWEI).toString(),
    );
    h.vault.evm.baseFee = 60n * GWEI; // 121 gwei > the 100 gwei cap
    expect((await params()).status).toBe(503);
  });

  it('a withdrawal priced under the base fee at the head of the lane is not started: retry with a new fee', async () => {
    const { s, token } = await takenSwap(h);
    h.vault.evm.baseFee = 20n * GWEI;
    const w = await paramsAndBuild(h, s, token, 'swap');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    h.vault.evm.baseFee = 45n * GWEI; // 45 + 1 > 41: this transfer could not be mined now
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
    const v = await view(h, s, token);
    expect(v.withdrawal).toEqual({ attempts: 1, last: 'start-failed', retry: true });
    expect(v.withdraw!.error!.code).toBe('stale-gas');
    expect(h.vault.submitted).toHaveLength(0);
    const w2 = await paramsAndBuild(h, s, token, 'swap', 'repriced');
    expect(w2.calls).not.toEqual(w.calls);
    expect((await proveWithdraw(h, s, token, w2)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w2.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('done');
  });

  it('the lane is released once the start is on chain: a transfer not yet mined does not hold the next withdrawal (probe P2)', async () => {
    const hold = gate();
    const { a, b } = await twoTaken(h);
    h.vault.defaultRelay = { beforeBroadcast: hold.promise };
    const wa = await paramsAndBuild(h, a.s, a.token, 'swap', 'a');
    expect(wa.evmNonce).toBe(9n);
    expect((await proveWithdraw(h, a.s, a.token, wa)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token)).status).toBe(202);
    await tick();
    const wb = await paramsAndBuild(h, b.s, b.token, 'swap', 'b');
    expect(wb.evmNonce).toBe(10n);
    expect((await proveWithdraw(h, b.s, b.token, wb)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(b.s.swapId), { tx: txHex(wb.tx) }, b.token)).status).toBe(202);
    await tick();
    expect(h.swaps.lanes().withdrawal).toEqual({ running: 0, waiting: 0 });
    expect(h.vault.startNonces.filter((x) => x.kind === 'withdraw').map((x) => x.nonce)).toEqual([9n, 10n]);
    hold.open();
    await h.swaps.idle();
    expect(h.store.get(a.s.swapId)!.state).toBe('done');
    expect(h.store.get(b.s.swapId)!.state).toBe('done');
  });

  it('a transfer signed but unmined for 30 min with the base fee above its cap is replaced by the next withdrawal (same nonce); the stuck one is refunded and retried', async () => {
    const hold = gate();
    const { a, b } = await twoTaken(h);
    const stuckPlan: { beforeBroadcast: Promise<void>; kind?: 'never-executed' } = { beforeBroadcast: hold.promise };
    h.vault.defaultRelay = stuckPlan;
    const wa = await paramsAndBuild(h, a.s, a.token, 'swap', 'a'); // 10 gwei at base 0.952
    await proveWithdraw(h, a.s, a.token, wa);
    await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token);
    await tick(); // A's start landed and the MPC signed nonce 9; it is not mined
    h.now.ms += 31 * 60_000;
    h.vault.evm.baseFee = 12n * GWEI; // 12 + 1 > 10: A cannot be mined now
    h.vault.defaultRelay = {};
    const wb = await paramsAndBuild(h, b.s, b.token, 'swap', 'b');
    expect(wb.evmNonce).toBe(9n); // the replacement
    expect((await proveWithdraw(h, b.s, b.token, wb)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(b.s.swapId), { tx: txHex(wb.tx) }, b.token)).status).toBe(202);
    await tick();
    expect(h.store.get(b.s.swapId)!.state).toBe('done'); // B mined at nonce 9 ...
    stuckPlan.kind = 'never-executed'; // ... so the MPC attests A never executed
    hold.open();
    await h.swaps.idle();
    const va = await view(h, a.s, a.token);
    expect(va.state).toBe('minted');
    expect(va.withdrawal).toEqual({ attempts: 1, last: 'refunded', retry: true });
  });

  it('a start the MPC has not signed for 2 h is replaced too', async () => {
    const { a, b } = await twoTaken(h);
    h.vault.defaultRelay = { fail: "timed out after 1200 s waiting for the MPC's signature on x (expected signer y)" };
    const wa = await paramsAndBuild(h, a.s, a.token, 'swap', 'a');
    await proveWithdraw(h, a.s, a.token, wa);
    await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token);
    await h.swaps.idle();
    h.vault.defaultRelay = {};
    h.now.ms += 30 * 60_000;
    expect((await paramsAndBuild(h, b.s, b.token, 'swap', 'b1')).evmNonce).toBe(10n); // A still holds 9
    h.now.ms += 2 * 3_600_000;
    expect((await paramsAndBuild(h, b.s, b.token, 'swap', 'b2')).evmNonce).toBe(9n); // A is stale: replaced
  });

  it('the sweep signs the largest fee the ETH at the deposit address covers, and waits for more ETH when the base fee outgrew it', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s); // sized at base 0.952 gwei: 2.5 gwei, 65,000 gas
    fund(h, o);
    h.vault.evm.baseFee = 3n * GWEI; // 1.25 × 3 + 0.5 = 4.25 gwei > the 2.5 gwei the ETH covers
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('awaiting_funds');
    expect(h.vault.log.filter((l) => l.startsWith('startDeposit'))).toHaveLength(0);
    expect(rec.sweepGas).toMatchObject({
      maxFeePerGas: (65n * GWEI) / 10n + '',
      ethWei: (65_000n * 65n * GWEI) / 10n + '',
    });
    expect((await view(h, s, o.swapToken)).sweepGas.ethWei).toBe(rec.sweepGas.ethWei);
    h.vault.evm.setEth(o.depositAddress, 65_000n * 7n * GWEI); // the page topped up (a little more)
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('minted');
    expect(h.vault.log.find((l) => l.startsWith('startDeposit'))).toMatch(/gas=65000x7000000000$/);
  });
});

describe('C3: a withdrawal whose start landed keeps its EVM nonce until it settles', () => {
  it('after a signature timeout the next withdrawal takes the next nonce, also after a restart', async () => {
    const { a, b } = await twoTaken(h);
    h.vault.defaultRelay = { fail: "timed out after 1200 s waiting for the MPC's signature on x (expected signer y)" };
    const wa = await paramsAndBuild(h, a.s, a.token, 'swap', 'a');
    expect(wa.evmNonce).toBe(9n);
    await proveWithdraw(h, a.s, a.token, wa);
    await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token);
    await h.swaps.idle();
    expect(h.store.get(a.s.swapId)!.withdrawals.at(-1)!.stage).toBe('relay-stalled');
    h.vault.defaultRelay = {};
    expect((await paramsAndBuild(h, b.s, b.token, 'swap', 'b')).evmNonce).toBe(10n);
    // a restart: a new service over the same store and chain
    const h2 = harness({ store: h.store, vault: h.vault, offers: h.offers });
    expect((await paramsAndBuild(h2, b.s, b.token, 'swap', 'b2')).evmNonce).toBe(10n);
  });
});

// ── C4 ─────────────────────────────────────────────────────────────────────────

/** A separately balanced transfer someone appends: one more coin in, one more coin out. */
const withExtraTransfer = (s: ReturnType<typeof bidTake>) => {
  const shielded = {
    inputs: [...s.shielded.inputs, { nullifier: 'ee'.repeat(32), contract: null }],
    outputs: [...s.shielded.outputs, { commitment: 'ff'.repeat(32), contract: null }],
  };
  return summaryWith(s, shielded);
};

describe('C4: the sponsor binds every shielded coin, not only the calls and the net imbalances', () => {
  it('/prove withdraw refuses the withdrawal with a separately balanced transfer appended (and proves nothing)', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    const res = await proveWithdraw(h, s, token, { ...w, tx: withExtraTransfer(w.tx) });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { detail: string } }).error.detail).toBe('extra-coins');
    expect(h.prover.proved).toHaveLength(1); // the take's only
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
  });

  it('/prove withdraw refuses a transaction whose coin for the vault is not this withdrawal’s', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    const otherCoin = summaryWith(w.tx, {
      inputs: w.tx.shielded.inputs,
      outputs: [{ commitment: '12'.repeat(32), contract: w.tx.shielded.outputs[0]!.contract }],
    });
    const res = await proveWithdraw(h, s, token, { ...w, tx: otherCoin });
    expect(((await res.json()) as { error: { detail: string } }).error.detail).toBe('missing-output');
  });

  it('/withdraw refuses a transaction that differs from the proven one in its coins (the same calls)', async () => {
    const { s, token } = await takenSwap(h);
    const w = await paramsAndBuild(h, s, token, 'swap');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    const res = await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(withExtraTransfer(w.tx)) }, token);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not-proven');
    expect(h.vault.submitted).toHaveLength(0);
  });

  it('/prove take refuses a take with an extra balanced transfer; one change coin is fine', async () => {
    const m = await mintedSwap(h);
    const extra = await post(
      h,
      SWAP_PATHS.prove(m.s.swapId),
      { purpose: 'take', tx: txHex(withExtraTransfer(bidTake())) },
      m.token,
    );
    expect(extra.status).toBe(422);
    expect(((await extra.json()) as { error: { detail: string } }).error.detail).toBe('extra-coins');
    const change = summaryWith(bidTake(), {
      inputs: [{ nullifier: '01'.repeat(32), contract: null }],
      outputs: [
        { commitment: '02'.repeat(32), contract: null },
        { commitment: '03'.repeat(32), contract: null },
      ],
    });
    expect((await post(h, SWAP_PATHS.prove(m.s.swapId), { purpose: 'take', tx: txHex(change) }, m.token)).status).toBe(
      200,
    );
  });

  it('open refuses an offer whose maker transaction is not the one its id names (offerId = sha256 of its bytes)', async () => {
    const s = bidSwap(h);
    h.offers.makerIds.set(`swapoffer1${BID.offerId}`, 'ab'.repeat(32)); // the kernel serves other bytes
    const res = await post(h, SWAP_PATHS.swaps, await openBody(h, s));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { detail: string } }).error.detail).toBe('maker-tx');
  });
});

// The P4.2 security fix pass, sponsor side (plan 00048 P4.2-fix, lane FS; audit
// audits/00048-evm-midnight-transparent-security.md, Consolidation rows C1–C16). Each describe block
// names its row; each test failed before its fix (several started from auditor A's probes,
// evidence/00048-evm-midnight-transparent/p4-audit/probes-a/audit-a.test.ts).

import { SWAP_PATHS, SwapViewSchema, type SwapView } from '@evm-midnight-transparent/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { VAULT_EVM } from './fakes.js';
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

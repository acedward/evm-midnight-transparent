// The P4.2 round-4 fix pass, sponsor side (plan 00048 P4.2-fix4, lane FS4; audit
// audits/00048-evm-midnight-transparent-security.md, "Consolidation, round 4" rows T1 and T2). Each
// describe block names its row; each test failed before its fix (several start from auditor A's
// round-4 probes R4-F-A41 / R4-F-A41b / R4-F-A41c, evidence/00048-evm-midnight-transparent/
// p4-audit/probes-a4/, and Codex's F-B41).
//
// T1's premise was corrected (questions file Q16): a settle's mint nonce is not public, so a coin that
// ANOTHER party's settle minted can never be found by the temporary wallet. What the sponsor does is
// containment: it never retries a settle whose request is gone, tells its own lost-answer settle (the
// flow continues) from another party's (the amount is recorded as lost, the swap goes on with what is
// left, or ends `failed` / `settled-elsewhere`), and counts foreign sweeps another party completed.

import { SETTLED_ELSEWHERE_REASON, SWAP_PATHS, SwapViewSchema, type SwapView } from '@evm-midnight-transparent/core';
import { Wallet } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';

import { partialOf } from '../../web/src/swap/partial.js';
import { SwapViewSchema as WebSwapViewSchema } from '../../web/src/swap/sponsor-client.js';
import { VAULT_EVM, gate } from './fakes.js';
import {
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

/** The stale closer for 3 hours (auditor A's probe loop): every stalled swap is driven again. */
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

const sponsorSettles = (hh: Harness, circuit: string) => hh.vault.settles.filter((x) => x.circuit === circuit);

/** A funded swap whose deposit is held right before its attestation (the griefer acts there). */
async function depositHeldAtAttestation(hh: Harness, tag: string, kind: 'success' | 'never-executed' = 'success') {
  const s = bidSwap(hh, Wallet.createRandom(), tag);
  const o = await openSwap(hh, s);
  fund(hh, o);
  const hold = gate();
  hh.vault.defaultRelay = { kind, beforeAttest: hold.promise };
  await hh.swaps.pollDeposits();
  await tick();
  const requestId = hh.store.get(s.swapId)!.deposit!.requestId!;
  expect(requestId).toBeTruthy();
  return { s, o, hold, requestId };
}

let h: Harness;
beforeEach(() => {
  h = harness({ config: testConfig(LIMITS) });
  vaultReady(h);
});

// ── T1: deposits ───────────────────────────────────────────────────────────────

describe('T1: a deposit request settled by another party is resolved, never retried (probe R4-F-A41)', () => {
  it('the griefer completes the swap’s own deposit first, with ITS mint nonce and encryption key: the sponsor does not retry, records the loss and ends the swap honestly (the coin cannot be found: Q16)', async () => {
    const { s, o, hold, requestId } = await depositHeldAtAttestation(h, 'gd');
    // The attestation is public: the griefer settles first. Its sweep took the tokens from the address.
    h.vault.griefSettle(requestId, 'success');
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, 0n);
    hold.open();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('failed');
    expect(rec.reason).toBe(SETTLED_ELSEWHERE_REASON);
    expect(rec.recoverable).toBe(false);
    expect(rec.message).toMatch(/Another party completed this swap's bridge request/);
    expect(rec.message).toMatch(/104\.166667 stkA/);
    const v = await view(h, s, o.swapToken);
    expect(v.settledElsewhere).toEqual([
      expect.objectContaining({
        kind: 'deposit',
        requestId,
        attested: 'success',
        colour: o.swap.pay.colour,
        amount: o.amount,
        lost: true,
        evmTx: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      }),
    ]);
    expect(v.recoverable).toBe(false);
    // The griefer's settle sealed the coin to its own key, with its own nonce; the sponsor's own
    // completion failed at its assertion ("Deposit not found") and is never tried again.
    expect(h.vault.foreignSettles).toEqual([expect.objectContaining({ circuit: 'completeDeposit', requestId })]);
    expect(h.vault.foreignSettles[0]!.encPk).not.toBe(s.payload.tempEncPk);
    expect(sponsorSettles(h, 'completeDeposit')).toHaveLength(1);
    expect(await closerFor3h(h)).toBe(0);
    expect(sponsorSettles(h, 'completeDeposit')).toHaveLength(1);
    expect(h.store.get(s.swapId)!.state).toBe('failed');
    // The page ends the swap with the sponsor's sentence and no Resume (its schema keeps the entry).
    const web = WebSwapViewSchema.parse(JSON.parse(JSON.stringify(v)));
    expect(web.settledElsewhere?.[0]).toMatchObject({ lost: true, amount: o.amount });
  });

  it('the sponsor’s OWN completion landed but its answer was lost: the request is gone, its transaction is found by identifier, and the swap is minted (the flow continues)', async () => {
    const { s, o, hold } = await depositHeldAtAttestation(h, 'own');
    h.vault.settleFailure = 'lost-landed';
    hold.open();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('minted');
    expect(rec.deposit!.stages.map((x) => x.stage)).toEqual(expect.arrayContaining(['settled-elsewhere', 'completed']));
    expect(rec.deposit!.stages.find((x) => x.stage === 'settled-elsewhere')!.detail).toMatchObject({
      by: 'sponsor',
      lost: 'false',
    });
    expect(rec.settledElsewhere ?? []).toEqual([]);
    expect(sponsorSettles(h, 'completeDeposit')).toHaveLength(1);
    // The flow continues: the take is proven.
    expect((await post(h, SWAP_PATHS.prove(s.swapId), takeBody(s), o.swapToken)).status).toBe(200);
  });

  it('a crash after the sponsor’s completion landed: the restart finds the request gone and its own transaction, before relaying again', async () => {
    const { s, hold } = await depositHeldAtAttestation(h, 'crash');
    h.vault.settleFailure = 'lost-landed';
    // The resolution cannot read the vault (the sponsor "stops" there): the swap stays depositing.
    const realOpen = h.vault.openRequests.bind(h.vault);
    let down = true;
    h.vault.openRequests = async (k) => {
      if (down) throw new Error('the indexer is unreachable');
      return realOpen(k);
    };
    hold.open();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('depositing');
    down = false;
    const relays = h.vault.log.filter((l) => l.startsWith('relay deposit')).length;
    await closerFor3h(h);
    expect(h.store.get(s.swapId)!.state).toBe('minted');
    expect(h.vault.log.filter((l) => l.startsWith('relay deposit')).length).toBe(relays); // no relay again
    expect(sponsorSettles(h, 'completeDeposit')).toHaveLength(1);
  });

  it('the sponsor’s completion did not land and the griefer’s did: decided only once the sponsor’s own attempt expired (as of the indexer’s head)', async () => {
    const { s, o, hold, requestId } = await depositHeldAtAttestation(h, 'late');
    h.vault.settleFailure = 'lost'; // sent; never included
    hold.open();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('depositing');
    h.vault.griefSettle(requestId, 'success');
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, 0n);
    // Within its time to live it could still land: nothing is decided.
    h.vault.indexerLagMs = 10 * MIN;
    h.now.ms += 5 * MIN;
    for (const r of h.swaps.stalled(Math.floor(h.now.ms / 1000))) h.swaps.redrive(r);
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('depositing');
    h.vault.indexerLagMs = 0;
    await closerFor3h(h);
    const rec = h.store.get(s.swapId)!;
    expect(rec).toMatchObject({ state: 'failed', reason: SETTLED_ELSEWHERE_REASON });
    expect(rec.settledElsewhere).toEqual([expect.objectContaining({ requestId, lost: true })]);
    expect(sponsorSettles(h, 'completeDeposit')).toHaveLength(1);
  });

  it('another party abandons the swap’s never-executed sweep first: nothing is lost, the swap waits for its funds again and starts anew', async () => {
    const { s, o, hold, requestId } = await depositHeldAtAttestation(h, 'ab', 'never-executed');
    h.vault.griefSettle(requestId, 'never-executed');
    hold.open();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('awaiting_funds');
    expect(rec.settledElsewhere).toEqual([
      expect.objectContaining({ requestId, lost: false, attested: 'never-executed' }),
    ]);
    expect(h.vault.log.filter((l) => l.startsWith('abandonDeposit'))).toHaveLength(1);
    // The funds are still at the address: the sponsor starts a new deposit and it mints.
    h.vault.defaultRelay = {};
    h.now.ms += MIN;
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('minted');
    expect((await view(h, s, o.swapToken)).settledElsewhere![0]!.lost).toBe(false);
  });
});

// ── T1: withdrawals ────────────────────────────────────────────────────────────

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

describe('T1: a withdrawal request settled by another party is resolved, never retried (probe R4-F-A41b)', () => {
  it('another party completes a SUCCESSFUL withdrawal first: nothing was minted, the swap is done', async () => {
    const { s, token, hold, requestId } = await withdrawHeldAtAttestation(h, 'cw', 'success');
    h.vault.griefSettle(requestId, 'success');
    hold.open();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec).toMatchObject({ state: 'done', outcome: 'swapped' });
    const v = await view(h, s, token);
    expect(v.settledElsewhere).toEqual([expect.objectContaining({ kind: 'withdraw', requestId, lost: false })]);
    expect(sponsorSettles(h, 'completeWithdraw')).toHaveLength(1);
    expect(await closerFor3h(h)).toBe(0);
    expect(sponsorSettles(h, 'completeWithdraw')).toHaveLength(1);
  });

  it('the griefer REFUNDS the never-executed withdrawal first, sealed to its key: the refund is lost; the swap ends failed, with no retry signal', async () => {
    const { s, token, hold, requestId } = await withdrawHeldAtAttestation(h, 'rw', 'never-executed');
    h.vault.griefSettle(requestId, 'never-executed');
    hold.open();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec).toMatchObject({ state: 'failed', reason: SETTLED_ELSEWHERE_REASON, recoverable: false });
    const v = await view(h, s, token);
    expect(v.withdrawal).toMatchObject({ retry: false });
    expect(v.settledElsewhere).toEqual([
      expect.objectContaining({
        kind: 'withdraw',
        requestId,
        attested: 'never-executed',
        lost: true,
        amount: '1000000',
      }),
    ]);
    expect(rec.message).toMatch(/1 USDC/);
    expect(await closerFor3h(h)).toBe(0);
    expect(sponsorSettles(h, 'refundWithdraw')).toHaveLength(1);
  });

  it('the sponsor’s own refund landed but its answer was lost: refunded as usual, and the page rebuilds', async () => {
    const { s, token, hold } = await withdrawHeldAtAttestation(h, 'or', 'never-executed');
    h.vault.settleFailure = 'lost-landed';
    hold.open();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('minted');
    expect(rec.withdrawals.at(-1)!.stage).toBe('refunded');
    expect((await view(h, s, token)).withdrawal).toMatchObject({ last: 'refunded', retry: true });
  });

  it('an uncertain start that another party refunded is LOST, not "back in the temporary wallet" (reconciliation)', async () => {
    const m = await takenSwap(h, bidSwap(h, Wallet.createRandom(), 'ur'));
    const w = withdrawFor(h, m.s, 'swap', { coinNonce: hex32('ur') });
    expect((await proveWithdraw(h, m.s, m.token, w)).status).toBe(200);
    // The start lands, but the submission reports an error and the vault read misses it: uncertain.
    const realOpen = h.vault.openRequests.bind(h.vault);
    let hide = true;
    h.vault.openRequests = async (k) => {
      const o = await realOpen(k);
      return hide && k === 'withdraw' ? { ...o, ids: [] } : o;
    };
    h.vault.submitFailure = 'lost-landed';
    expect((await post(h, SWAP_PATHS.withdraw(m.s.swapId), { tx: txHex(w.tx) }, m.token)).status).toBe(202);
    await h.swaps.idle();
    const wr = h.store.get(m.s.swapId)!.withdrawals.at(-1)!;
    expect(wr.stage).toBe('submission-uncertain');
    hide = false;
    // Its transfer never executed; another party refunds it with its own nonce and key.
    h.vault.griefSettle(wr.requestId!, 'never-executed');
    h.now.ms += 16 * MIN;
    await h.swaps.adoptLateStarts();
    await h.swaps.idle();
    const rec = h.store.get(m.s.swapId)!;
    expect(rec).toMatchObject({ state: 'failed', reason: SETTLED_ELSEWHERE_REASON });
    const v = await view(h, m.s, m.token);
    expect(v.withdrawal?.retry).toBe(false);
    expect(v.settledElsewhere).toEqual([expect.objectContaining({ requestId: wr.requestId, lost: true })]);
  });
});

// ── T1: foreign sweeps another party completed (F-A41 point 3) ─────────────────

/** Auditor A's R4-F-A41c: the sponsor's own sweep loses the nonce race to a griefer's 1-unit request,
 *  which the griefer completes itself at once, so the sponsor never sees it open. */
async function griefedSweep(hh: Harness, tag: string, units = 1n) {
  const s = bidSwap(hh, Wallet.createRandom(), tag);
  const o = await openSwap(hh, s);
  fund(hh, o);
  const hold = gate();
  hh.vault.defaultRelay = { kind: 'never-executed', beforeBroadcast: hold.promise };
  await hh.swaps.pollDeposits();
  await tick();
  // The griefer's sweep executes (a Transfer log out of the deposit address) and it settles it.
  hh.vault.evm.transfer(o.erc20Address, o.depositAddress, VAULT_EVM, units);
  hh.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei) - 51_577n * 2n * GWEI);
  hold.open();
  await hh.swaps.idle();
  hh.vault.defaultRelay = {};
  return { s, o };
}

const passes = async (hh: Harness, n: number, stepMs = 3 * MIN) => {
  for (let i = 0; i < n; i++) {
    hh.now.ms += stepMs;
    await hh.swaps.pollDeposits();
    await hh.swaps.idle();
  }
};

describe('T1: a foreign sweep the griefer completed itself is counted from Sepolia’s Transfer logs (probe R4-F-A41c)', () => {
  it('the lost unit is recorded; what waits at the address is deposited once the sweep ETH is back, and the page can bridge it back', async () => {
    const { s, o } = await griefedSweep(h, 'fs');
    await passes(h, 4);
    let rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('partial');
    expect(rec.settledElsewhere).toEqual([
      expect.objectContaining({ kind: 'deposit', attested: 'success', amount: '1', lost: true }),
    ]);
    expect(rec.settledElsewhere![0]!.evmTx).toMatch(/^0x[0-9a-f]{64}$/);
    let v = await view(h, s, o.swapToken);
    const rest = (BigInt(o.amount) - 1n).toString();
    expect(v.partial).toEqual({ minted: '0', remaining: rest, atAddress: rest, options: ['wait'] });
    // The page's reader: "Wait" (the sweep-ETH top-up only), no Bridge back yet.
    expect(partialOf(WebSwapViewSchema.parse(JSON.parse(JSON.stringify(v))), BigInt(o.amount))).toMatchObject({
      canWait: true,
      canBridgeBack: false,
    });
    // The page tops the sweep ETH up: the sponsor deposits what waits at the address, by itself.
    h.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei));
    await passes(h, 1);
    rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('partial');
    expect(h.vault.log.filter((l) => l.startsWith('startDeposit')).at(-1)).toMatch(new RegExp(` ${rest} `));
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, 0n); // its sweep took them
    await passes(h, 2);
    v = await view(h, s, o.swapToken);
    expect(v.partial).toMatchObject({ minted: rest, remaining: '0', options: ['bridge-back'] });
    // Bridge back what arrived: the swap then ends done, with the lost unit on record.
    const p = (await (await get(h, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=bridge-back`, o.swapToken)).json()) as {
      amount: string;
      evmNonce: string;
      gas: { maxFeePerGas: string; maxPriorityFeePerGas: string };
    };
    expect(p.amount).toBe(rest);
    const w = withdrawFor(h, s, 'bridge-back', {
      evmNonce: BigInt(p.evmNonce),
      coinNonce: hex32('fs-bb'),
      amount: BigInt(p.amount),
      maxFeePerGas: BigInt(p.gas.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(p.gas.maxPriorityFeePerGas),
    });
    expect((await proveWithdraw(h, s, o.swapToken, w)).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, o.swapToken)).status).toBe(202);
    await h.swaps.idle();
    rec = h.store.get(s.swapId)!;
    expect(rec).toMatchObject({ state: 'done', outcome: 'bridged-back' });
    expect((await view(h, s, o.swapToken)).settledElsewhere).toEqual([
      expect.objectContaining({ amount: '1', lost: true }),
    ]);
  });

  it('a griefer that swept and settled EVERYTHING: the swap ends failed / settled-elsewhere instead of waiting for funds forever', async () => {
    const { s, o } = await griefedSweep(h, 'all', 104_166_667n);
    await passes(h, 4);
    const rec = h.store.get(s.swapId)!;
    expect(rec).toMatchObject({ state: 'failed', reason: SETTLED_ELSEWHERE_REASON, recoverable: false });
    expect((await view(h, s, o.swapToken)).settledElsewhere).toEqual([
      expect.objectContaining({ amount: o.amount, lost: true }),
    ]);
  });

  it('a foreign sweep still open (the sponsor completes it) is not counted as lost, and the rest is deposited as usual', async () => {
    const s = bidSwap(h, Wallet.createRandom(), 'open');
    const o = await openSwap(h, s);
    fund(h, o);
    const hold = gate();
    h.vault.defaultRelay = { kind: 'never-executed', beforeBroadcast: hold.promise };
    await h.swaps.pollDeposits();
    await tick();
    const f = await h.vault.startDeposit({
      recipientCoinPk: s.payload.tempCoinPk,
      erc20: o.erc20Address,
      amount: 1n,
      gas: { gasLimit: 65_000n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: 2n * GWEI, keyVersion: 1n },
      evmNonce: 0n,
    });
    h.vault.evm.transfer(o.erc20Address, o.depositAddress, VAULT_EVM, 1n);
    h.vault.attestations.set(f.requestId, 'success');
    hold.open();
    await h.swaps.idle();
    h.vault.defaultRelay = {};
    await passes(h, 4);
    const rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere ?? []).toEqual([]);
    expect(rec.deposit!.stages.map((x) => x.stage)).toContain('completed-foreign');
    // 1 unit through the foreign request, the rest through the sponsor's own: the whole pay amount.
    expect(rec.state).toBe('minted');
    expect(rec.deposit!.mintedTotal).toBe(o.amount);
  });

  it('the sponsor’s completion of a foreign request loses the race to the griefer: lost, counted once, never settled again', async () => {
    const s = bidSwap(h, Wallet.createRandom(), 'race');
    const o = await openSwap(h, s);
    fund(h, o);
    const hold = gate();
    h.vault.defaultRelay = { kind: 'never-executed', beforeBroadcast: hold.promise };
    await h.swaps.pollDeposits();
    await tick();
    const f = await h.vault.startDeposit({
      recipientCoinPk: s.payload.tempCoinPk,
      erc20: o.erc20Address,
      amount: 1n,
      gas: { gasLimit: 65_000n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: 2n * GWEI, keyVersion: 1n },
      evmNonce: 0n,
    });
    h.vault.evm.transfer(o.erc20Address, o.depositAddress, VAULT_EVM, 1n);
    h.vault.attestations.set(f.requestId, 'success');
    h.vault.sweepsMove = true;
    // The griefer settles right as the sponsor's completion is built.
    const realSettle = h.vault.settle.bind(h.vault);
    h.vault.settle = async (i) => {
      if (i.requestId === f.requestId && h.vault.requests.has(f.requestId)) h.vault.griefSettle(f.requestId, 'success');
      return realSettle(i);
    };
    hold.open();
    await h.swaps.idle();
    h.vault.defaultRelay = {};
    await passes(h, 6);
    const rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere).toEqual([
      expect.objectContaining({ requestId: f.requestId, amount: '1', lost: true }),
    ]);
    expect(h.vault.settles.filter((x) => x.requestId === f.requestId)).toHaveLength(1);
    // What waited at the address was deposited by the sponsor; it can go back; the lost unit is not
    // counted twice (the Transfer logs explain it).
    const rest = (BigInt(o.amount) - 1n).toString();
    expect(rec.state).toBe('partial');
    expect(rec.deposit!.mintedTotal).toBe(rest);
    expect((await view(h, s, o.swapToken)).partial).toMatchObject({
      minted: rest,
      remaining: '0',
      options: ['bridge-back'],
    });
  });
});

// ── T2 ─────────────────────────────────────────────────────────────────────────

/** A request for the swap's recipient at the deposit address's next nonce (anyone may post one). */
const competitor = (
  hh: Harness,
  s: SwapInput,
  o: { erc20Address: string },
  gas: { gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
  amount = 1n,
) =>
  hh.vault.startDeposit({
    recipientCoinPk: s.payload.tempCoinPk,
    erc20: o.erc20Address,
    amount,
    gas: { ...gas, keyVersion: 1n },
    evmNonce: 0n,
  });

describe('T2: only a request that can execute is adopted or competed with (F-B41)', () => {
  it('a request with gas limit 1 and a huge fee cap is ignored: the sponsor posts its own at its own price', async () => {
    const s = bidSwap(h, Wallet.createRandom(), 'g1');
    const o = await openSwap(h, s);
    fund(h, o);
    // Affordable on paper (1 × 1,000 gwei), never a valid transaction (below the intrinsic 21,000).
    await competitor(h, s, o, { gasLimit: 1n, maxFeePerGas: 1_000n * GWEI, maxPriorityFeePerGas: 2n * GWEI });
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('minted');
    const own = h.vault.log.filter((l) => l.startsWith('startDeposit')).at(-1)!;
    expect(own).toMatch(/gas=65000x/);
    // At its own price: no 110% of a 1,000 gwei cap (which would need 0.0715 ETH).
    const fee = BigInt(own.split('x').at(-1)!);
    expect(fee).toBeLessThan(10n * GWEI);
    expect(rec.sweepGas).toEqual(o.sweepGas); // never raised for it
  });

  it('a request whose transfer cannot execute (the estimate reverts, or it needs more gas than its limit) is ignored, even when the address’s ETH pays its huge fee cap', async () => {
    // The griefer also tops the deposit address's ETH up (audit F-A43's lever), so its request is
    // "affordable": 25,000 × 150 gwei ≤ 0.005 ETH, and outbidding it would pass SWEEP_MAX_WEI.
    for (const [tag, setup] of [
      [
        'rev',
        (hh: Harness, s: SwapInput, o: { erc20Address: string }) =>
          competitor(
            hh,
            s,
            o,
            { gasLimit: 25_000n, maxFeePerGas: 150n * GWEI, maxPriorityFeePerGas: 2n * GWEI },
            10n ** 15n,
          ),
      ],
      [
        'low',
        (hh: Harness, s: SwapInput, o: { erc20Address: string }) =>
          competitor(hh, s, o, { gasLimit: 25_000n, maxFeePerGas: 150n * GWEI, maxPriorityFeePerGas: 2n * GWEI }),
      ],
      [
        'big',
        (hh: Harness, s: SwapInput, o: { erc20Address: string }) =>
          competitor(hh, s, o, {
            gasLimit: 20_000_000n,
            maxFeePerGas: 200_000_000n,
            maxPriorityFeePerGas: 100_000_000n,
          }),
      ],
    ] as const) {
      const hh = harness({ config: testConfig(LIMITS) });
      vaultReady(hh);
      const s = bidSwap(hh, Wallet.createRandom(), tag);
      const o = await openSwap(hh, s);
      fund(hh, o, { eth: 5_000_000_000_000_000n });
      await setup(hh, s, o);
      await hh.swaps.pollDeposits();
      await hh.swaps.idle();
      expect(hh.store.get(s.swapId)!.state).toBe('minted');
    }
  });

  it('an executable competitor is still outbid on both fee fields (control), and without an estimate the 30,000 floor applies', async () => {
    const s = bidSwap(h, Wallet.createRandom(), 'ok');
    const o = await openSwap(h, s);
    fund(h, o, { eth: 10n ** 15n });
    await competitor(h, s, o, { gasLimit: 60_000n, maxFeePerGas: 5n * GWEI, maxPriorityFeePerGas: 2n * GWEI });
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const own = h.vault.log.filter((l) => l.startsWith('startDeposit')).at(-1)!;
    expect(BigInt(own.split('x').at(-1)!)).toBeGreaterThanOrEqual(5_500_000_000n);

    const hh = harness({ config: testConfig(LIMITS) });
    vaultReady(hh);
    hh.vault.evm.estimateFails = true;
    const s2 = bidSwap(hh, Wallet.createRandom(), 'floor');
    const o2 = await openSwap(hh, s2);
    fund(hh, o2, { eth: 5n * 10n ** 16n }); // the griefer's ETH: 29,999 × 1,000 gwei is "affordable"
    await competitor(hh, s2, o2, { gasLimit: 29_999n, maxFeePerGas: 1_000n * GWEI, maxPriorityFeePerGas: 2n * GWEI });
    await hh.swaps.pollDeposits();
    await hh.swaps.idle();
    expect(hh.store.get(s2.swapId)!.state).toBe('minted');
  });

  it('a request with the swap’s own parameters whose transfer needs more than its gas limit is not adopted', async () => {
    const s = bidSwap(h, Wallet.createRandom(), 'ad');
    const o = await openSwap(h, s);
    fund(h, o);
    const own = await competitor(
      h,
      s,
      o,
      {
        gasLimit: BigInt(o.sweepGas.gasLimit),
        maxFeePerGas: BigInt(o.sweepGas.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(o.sweepGas.maxPriorityFeePerGas),
      },
      BigInt(o.amount),
    );
    h.vault.evm.transferGas.set(o.erc20Address.toLowerCase(), BigInt(o.sweepGas.gasLimit) + 1n);
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.deposit!.stages.map((x) => x.stage)).not.toContain('adopted');
    expect(rec.deposit!.requestId).not.toBe(own.requestId);
  });
});

// The P4.2 round-6 fix pass (plan 00048 P4.2-fix6; audit audits/00048-evm-midnight-transparent-security.md,
// "Consolidation, round 6" row V1, from Codex's F-B61 and auditor A's F-A61). U2 explains a drop at
// the deposit address only by a sweep whose transaction (`eth_getTransactionByHash`) IS a pending
// request's signed sweep. A lookup that answers null (a load-balanced RPC whose node trails the one
// that served the `Transfer` logs) or fails is UNRESOLVED: no loss is judged on that pass, and the
// next count reads it again. Started from auditor A's probe R6-U2 "regression check"
// (evidence/00048-evm-midnight-transparent/p4-audit/probes-a6/audit-a-r6.test.ts).

import { Wallet } from 'ethers';
import { beforeEach, describe, expect, it } from 'vitest';

import type { EvmTransaction } from '../src/swaps/backend.js';
import { VAULT_EVM, gate } from './fakes.js';
import { bidSwap, fund, harness, openSwap, testConfig, tok, type Harness, type SwapInput } from './harness.js';

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

let h: Harness;
beforeEach(() => {
  h = harness({ config: testConfig(LIMITS) });
  h.vault.evm.nonces.set(VAULT_EVM.toLowerCase(), { latest: 9n, pending: 9n });
  h.vault.evm.setEth(VAULT_EVM, 10n ** 17n);
  for (const t of [tok('stkA'), tok('USDC')]) h.vault.evm.setErc20(t.sepoliaAddress, VAULT_EVM, 10n ** 12n);
});

const passes = async (hh: Harness, n: number, stepMs = 3 * MIN) => {
  for (let i = 0; i < n; i++) {
    hh.now.ms += stepMs;
    await hh.swaps.pollDeposits();
    await hh.swaps.idle();
  }
};

/** A request for the swap's recipient (anyone may post one: `startDeposit` is permissionless). */
const foreignDeposit = (
  hh: Harness,
  s: SwapInput,
  erc20: string,
  amount: bigint,
  evmNonce: bigint,
  gas: { gasLimit?: bigint } = {},
) =>
  hh.vault.startDeposit({
    recipientCoinPk: s.payload.tempCoinPk,
    erc20,
    amount,
    evmNonce,
    gas: {
      gasLimit: gas.gasLimit ?? 65_000n,
      maxFeePerGas: 3n * GWEI,
      maxPriorityFeePerGas: 2n * GWEI,
      keyVersion: 1n,
    },
  });

/** The fake Sepolia's `eth_getTransactionByHash` behind a switch: `null` (the node serving it trails
 *  the one that served the logs), `throw` (the read fails), or the real answer. */
function lookup(hh: Harness) {
  const real = hh.vault.evm.transaction.bind(hh.vault.evm);
  const ctl = { mode: 'null' as 'null' | 'throw' | 'real', reads: 0 };
  hh.vault.evm.transaction = async (hash: string): Promise<EvmTransaction | null> => {
    ctl.reads++;
    if (ctl.mode === 'throw') throw new Error('Sepolia eth_getTransactionByHash: unreachable');
    return ctl.mode === 'null' ? null : real(hash);
  };
  return ctl;
}

/** Auditor A's set-up: the sponsor's own sweep loses the deposit address's nonce to anyone's request
 *  for the whole amount (benign: a second relayer, say), which sweeps first and is not attested yet. */
async function sweptByAnotherRequest(hh: Harness, tag: string) {
  const s = bidSwap(hh, Wallet.createRandom(), tag);
  const o = await openSwap(hh, s);
  fund(hh, o);
  const hold = gate();
  hh.vault.defaultRelay = { kind: 'never-executed', beforeBroadcast: hold.promise };
  await hh.swaps.pollDeposits();
  await tick();
  const f = await foreignDeposit(hh, s, o.erc20Address, BigInt(o.amount), 0n);
  const sweepTx = hh.vault.sweep(f.requestId);
  hold.open();
  await hh.swaps.idle();
  hh.vault.defaultRelay = {};
  return { s, o, f, sweepTx };
}

const settlesOf = (hh: Harness, requestId: string) => hh.vault.settles.filter((x) => x.requestId === requestId).length;

describe('V1 (F-B61, F-A61): a candidate sweep whose transaction cannot be read yet is unresolved, never a loss', () => {
  it('the Transfer log is seen before the transaction lookup answers, then the transaction, then the attestation: no loss is recorded and the swap recovers (minted)', async () => {
    const { s, o, f } = await sweptByAnotherRequest(h, 'v1n');
    const tx = lookup(h);
    // The lookup answers null while the drop is counted (the count runs at most every 10 minutes).
    await passes(h, 8);
    let rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere ?? []).toEqual([]);
    expect(rec.state).toBe('awaiting_funds');
    expect(rec.deposit!.stages.some((x) => x.stage === 'settled-elsewhere')).toBe(false);
    expect(h.vault.requests.has(f.requestId)).toBe(true);
    expect(tx.reads).toBeGreaterThanOrEqual(2); // looked at, and looked at again on a later count
    // The transaction becomes readable: it IS the request's signed sweep, still pending.
    tx.mode = 'real';
    await passes(h, 4);
    rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere ?? []).toEqual([]);
    expect(rec.state).toBe('awaiting_funds');
    // The MPC attests it: the sponsor completes it as this swap's deposit.
    h.vault.attestations.set(f.requestId, 'success');
    await passes(h, 4);
    h.now.ms += DAY;
    await passes(h, 2);
    rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere ?? []).toEqual([]);
    expect(rec.state).toBe('minted');
    expect(rec.deposit!.mintedTotal).toBe(o.amount);
    expect(settlesOf(h, f.requestId)).toBe(1);
    expect(h.vault.requests.has(f.requestId)).toBe(false);
  });

  it('a lookup that fails (the RPC errors) is unresolved too: no loss, read again, and the swap recovers once it answers', async () => {
    const { s, o, f } = await sweptByAnotherRequest(h, 'v1t');
    const tx = lookup(h);
    tx.mode = 'throw';
    await passes(h, 8);
    let rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere ?? []).toEqual([]);
    expect(rec.state).toBe('awaiting_funds');
    expect(tx.reads).toBeGreaterThanOrEqual(2);
    tx.mode = 'real';
    h.vault.attestations.set(f.requestId, 'success');
    await passes(h, 6);
    rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere ?? []).toEqual([]);
    expect(rec.state).toBe('minted');
    expect(rec.deposit!.mintedTotal).toBe(o.amount);
  });

  it('a real loss is only delayed: a sweep another party settled, with a dummy copying its nonce and amount; nothing judged while the lookup is null, the loss recorded once it reads', async () => {
    // The griefer's 1-unit request sweeps (its signed transaction mined) and is settled by the
    // griefer at once; the sponsor never saw it open.
    const s = bidSwap(h, Wallet.createRandom(), 'v1l');
    const o = await openSwap(h, s);
    fund(h, o);
    const hold = gate();
    h.vault.defaultRelay = { kind: 'never-executed', beforeBroadcast: hold.promise };
    await h.swaps.pollDeposits();
    await tick();
    const signed = { nonce: 0n, gasLimit: 65_000n, maxFeePerGas: 3n * GWEI, maxPriorityFeePerGas: 2n * GWEI };
    h.vault.evm.transfer(o.erc20Address, o.depositAddress, VAULT_EVM, 1n, { signed });
    h.vault.evm.bumpNonce(o.depositAddress);
    h.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei) - 51_577n * 2n * GWEI);
    hold.open();
    await h.swaps.idle();
    h.vault.defaultRelay = {};
    // A dummy request for the same amount at the swept nonce (it never swept: gas limit 1).
    await foreignDeposit(h, s, o.erc20Address, 1n, 0n, { gasLimit: 1n });
    const tx = lookup(h);
    await passes(h, 8);
    expect(h.store.get(s.swapId)!.settledElsewhere ?? []).toEqual([]);
    expect(tx.reads).toBeGreaterThanOrEqual(2);
    tx.mode = 'real';
    await passes(h, 4);
    const rec = h.store.get(s.swapId)!;
    expect(rec.settledElsewhere).toEqual([
      expect.objectContaining({ kind: 'deposit', attested: 'success', amount: '1', lost: true }),
    ]);
    expect(rec.state).toBe('partial');
  });
});

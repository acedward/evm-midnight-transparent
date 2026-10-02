// A whole swap through the routes, against fakes (a local integration test: no chain, no ports):
// the server-driven deposit, the take's proof, the withdrawal's proof and submission, refunds, and
// Bridge back; with every /prove and /withdraw refusal rule at the route.

import { SWAP_PATHS, type SwapView } from '@evm-midnight-transparent/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { VAULT, VAULT_EVM, gate } from './fakes.js';
import {
  BID,
  bidSwap,
  bidTake,
  bidTakeFor,
  fund,
  get,
  harness,
  hex32,
  mintedSwap,
  newWallet,
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
import type { TxSummary } from '../src/validate/summary.js';

const expectError = async (res: Response, status: number, code: string, detail?: string) => {
  const body = (await res.json()) as { error?: { code: string; detail?: string } };
  expect({ status: res.status, code: body.error?.code, ...(detail ? { detail: body.error?.detail } : {}) }).toEqual({
    status,
    code,
    ...(detail ? { detail } : {}),
  });
};

const view = async (h: Harness, s: SwapInput, token: string): Promise<SwapView> =>
  ((await (await get(h, SWAP_PATHS.swap(s.swapId), token)).json()) as { swap: SwapView }).swap;

const proveTake = (h: Harness, s: SwapInput, token: string, tx?: TxSummary) => {
  const t = bidTakeFor(s);
  return post(
    h,
    SWAP_PATHS.prove(s.swapId),
    { purpose: 'take', tx: txHex(tx ?? t.tx), walletOutputs: t.walletOutputs },
    token,
  );
};

async function takenSwap(h: Harness, s: SwapInput = bidSwap(h)) {
  const m = await mintedSwap(h, s);
  expect((await proveTake(h, s, m.token)).status).toBe(200);
  const r = await post(h, SWAP_PATHS.take(s.swapId), { outcome: 'taken', takeTx: hex32('take-tx') }, m.token);
  expect(r.status).toBe(200);
  return m;
}

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

let h: Harness;
beforeEach(() => {
  h = harness({ config: testConfig({ RATE_LIMIT_PROVES_PER_SWAP_PER_MIN: '100' }) });
  h.vault.evm.nonces.set(VAULT_EVM.toLowerCase(), { latest: 9n, pending: 9n });
  h.vault.evm.setEth(VAULT_EVM, 10n ** 17n);
  for (const t of [tok('stkA'), tok('USDC')]) h.vault.evm.setErc20(t.sepoliaAddress, VAULT_EVM, 10n ** 12n);
});

describe('the deposit is server-driven', () => {
  it('waits for the exact ERC20 amount AND the sweep ETH, then startDeposit → relayer → completeDeposit (sealed to the temporary keys)', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    // nothing yet
    await h.swaps.pollDeposits();
    expect(h.store.get(s.swapId)!.state).toBe('awaiting_funds');
    // one base unit short
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, BigInt(o.amount) - 1n);
    h.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei));
    await h.swaps.pollDeposits();
    expect(h.store.get(s.swapId)!.state).toBe('awaiting_funds');
    // the token, but not the sweep ETH
    h.vault.evm.setErc20(o.erc20Address, o.depositAddress, BigInt(o.amount));
    h.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei) - 1n);
    await h.swaps.pollDeposits();
    expect(h.store.get(s.swapId)!.state).toBe('awaiting_funds');
    // both
    fund(h, o);
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const v = await view(h, s, o.swapToken);
    expect(v.state).toBe('minted');
    expect(h.vault.log.filter((l) => !l.startsWith('broadcast'))).toEqual([
      `startDeposit ${s.payload.tempCoinPk.slice(0, 8)} 104166667 gas=65000x2500000000`,
      `relay deposit ${v.deposit!.requestId!.slice(0, 8)}`,
      `settle completeDeposit ${v.deposit!.requestId!.slice(0, 8)}`,
    ]);
    expect(h.vault.settles[0]).toMatchObject({ coinPk: s.payload.tempCoinPk, encPk: s.payload.tempEncPk });
    expect(v.deposit).toMatchObject({ stage: 'completed', attested: 'success', attempts: 1 });
    expect(v.deposit!.startTx).toMatch(/^[0-9a-f]{64}$/);
    expect(v.deposit!.sweepTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(v.deposit!.completeTx).toMatch(/^[0-9a-f]{64}$/);
    expect(v.deposit!.stages.map((x) => x.stage)).toEqual([
      'waiting-for-funds',
      'funds-seen',
      'starting',
      'started',
      'mpc-signed',
      'evm-broadcast',
      'evm-final',
      'attested',
      'completing',
      'completed',
    ]);
  });

  it('does not start while the sponsor cannot pay; starts once it can', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    h.sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 1n };
    await h.swaps.pollDeposits();
    expect(h.store.get(s.swapId)!.state).toBe('awaiting_funds');
    h.sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 10n ** 20n };
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('minted');
  });

  it('a sweep attested never-executed is abandoned and retried while the funds are there; attempts are capped', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    h.vault.defaultRelay = { kind: 'never-executed' };
    for (let i = 0; i < 3; i++) {
      await h.swaps.pollDeposits();
      await h.swaps.idle();
      expect(h.store.get(s.swapId)!.state).toBe('awaiting_funds');
    }
    expect(h.vault.log.filter((l) => l.startsWith('abandonDeposit'))).toHaveLength(3);
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!).toMatchObject({ state: 'failed', reason: 'deposit-attempts' });
  });

  it('a retried deposit succeeds after one never-executed sweep', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    h.vault.defaultRelay = { kind: 'never-executed' };
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    h.vault.defaultRelay = {};
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const v = await view(h, s, o.swapToken);
    expect(v.state).toBe('minted');
    expect(v.deposit!.attempts).toBe(2);
  });

  it('a deposit attested returned-false fails the swap (nothing minted)', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    h.vault.defaultRelay = { kind: 'returned-false' };
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!).toMatchObject({ state: 'failed', reason: 'deposit-returned-false' });
  });

  it('fails a swap whose funds never come, and a re-open keeps waiting', async () => {
    const hh = harness({ config: testConfig({ SWAP_FUNDS_WAIT_SECONDS: '60' }) });
    const s = bidSwap(hh);
    await openSwap(hh, s);
    hh.now.ms += 61_000;
    await hh.swaps.pollDeposits();
    expect(hh.store.get(s.swapId)!).toMatchObject({ state: 'failed', reason: 'funds-not-received' });
    const res = await post(hh, SWAP_PATHS.swaps, await openBody(hh, s));
    expect(res.status).toBe(200);
    expect(hh.store.get(s.swapId)!.state).toBe('awaiting_funds');
  });

  it('adopts an open deposit request of this swap instead of starting a second one', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    // a start that landed while the sponsor was not looking (a crash after it was sent)
    const landed = await h.vault.startDeposit({
      recipientCoinPk: s.payload.tempCoinPk,
      erc20: o.erc20Address,
      amount: BigInt(o.amount),
      gas: { gasLimit: 65_000n, maxFeePerGas: 2_500_000_000n, maxPriorityFeePerGas: 500_000_000n, keyVersion: 1n },
      evmNonce: 0n,
    });
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const v = await view(h, s, o.swapToken);
    expect(v.state).toBe('minted');
    expect(v.deposit!.requestId).toBe(landed.requestId);
    expect(h.vault.log.filter((l) => l.startsWith('startDeposit'))).toHaveLength(1);
  });
});

describe('/prove take: only this swap’s offer', () => {
  it('proves the take and moves to taking; the report moves to taken with the hash', async () => {
    const { s, token } = await mintedSwap(h);
    const res = await proveTake(h, s, token);
    expect(res.status).toBe(200);
    const { tx } = (await res.json()) as { tx: string };
    expect(Buffer.from(tx, 'hex').toString('utf8')).toMatch(/^PROVEN:FAKE-TX:/);
    expect(h.store.get(s.swapId)!.state).toBe('taking');
    const r = await post(h, SWAP_PATHS.take(s.swapId), { outcome: 'taken', takeTx: hex32('t') }, token);
    expect(((await r.json()) as { swap: SwapView }).swap).toMatchObject({ state: 'taken', takeTx: hex32('t') });
  });

  it('refuses the wrong offer, a wrong colour, a wrong amount, extra calls, garbage — and proves nothing', async () => {
    const { s, token } = await mintedSwap(h);
    const other = { colour: tok('stkB').midnightColour, amount: BID.pay.amount };
    await expectError(
      await proveTake(
        h,
        s,
        token,
        bidTake({
          imbalances: {
            '0': {
              [BID.receive.token.midnightColour]: BID.pay.amount,
              [BID.pay.token.midnightColour]: -BID.receive.amount,
            },
          },
        }),
      ),
      422,
      'invalid-tx',
      'wrong-offer',
    );
    await expectError(
      await proveTake(
        h,
        s,
        token,
        bidTake({
          imbalances: {
            '0': { [other.colour]: other.amount, [BID.receive.token.midnightColour]: -BID.receive.amount },
          },
        }),
      ),
      422,
      'invalid-tx',
      'another-colour',
    );
    await expectError(
      await proveTake(
        h,
        s,
        token,
        bidTake({
          imbalances: {
            '0': {
              [BID.pay.token.midnightColour]: BID.pay.amount - 1n,
              [BID.receive.token.midnightColour]: -BID.receive.amount,
            },
          },
        }),
      ),
      422,
      'invalid-tx',
      'wrong-amount',
    );
    await expectError(
      await proveTake(
        h,
        s,
        token,
        bidTake({ intents: 1, calls: [{ address: VAULT, entryPoint: 'startWithdraw', digest: 'x' }] }),
      ),
      422,
      'invalid-tx',
      'contract-calls',
    );
    await expectError(
      await post(h, SWAP_PATHS.prove(s.swapId), { purpose: 'take', tx: 'deadbeef' }, token),
      422,
      'invalid-tx',
      'not-a-transaction',
    );
    await expectError(
      await post(h, SWAP_PATHS.prove(s.swapId), { purpose: 'take', tx: 'xyz' }, token),
      400,
      'bad-request',
    );
    expect(h.prover.proved).toHaveLength(0);
    expect(h.store.get(s.swapId)!.state).toBe('minted');
  });

  it('refuses a take before the funds are minted, and when the offer is gone ("Swap is not available")', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    await expectError(await proveTake(h, s, o.swapToken), 409, 'wrong-state');
    fund(h, o);
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    h.offers.statusOverride.set(BID.offerId, 'consumed');
    await expectError(await proveTake(h, s, o.swapToken), 409, 'offer-not-available', 'consumed');
    expect(h.prover.proved).toHaveLength(0);
  });

  it('a lost race is reported as not-available: back to minted', async () => {
    const { s, token } = await mintedSwap(h);
    await proveTake(h, s, token);
    const r = await post(h, SWAP_PATHS.take(s.swapId), { outcome: 'not-available' }, token);
    expect(((await r.json()) as { swap: SwapView }).swap.state).toBe('minted');
  });

  it('caps the proofs per swap', async () => {
    const hh = harness({ config: testConfig({ SWAP_PROOFS_PER_SWAP: '2' }) });
    const { s, token } = await mintedSwap(hh);
    expect((await proveTake(hh, s, token)).status).toBe(200);
    expect((await proveTake(hh, s, token)).status).toBe(200);
    await expectError(await proveTake(hh, s, token), 429, 'proof-budget');
  });
});

describe('/prove withdraw and /withdraw: only this swap’s startWithdraw', () => {
  it('withdraw-params: the sponsor’s gas policy, the user as destination, the temporary wallet as refund, the nonce', async () => {
    const { s, token } = await takenSwap(h);
    const r = await get(h, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=swap`, token);
    expect(await r.json()).toEqual({
      kind: 'swap',
      colour: BID.receive.token.midnightColour,
      amount: '1000000',
      erc20Address: BID.receive.token.sepoliaAddress,
      dest: s.user.address,
      refundRecipient: s.payload.tempCoinPk,
      gas: { gasLimit: '100000', maxFeePerGas: '10000000000', maxPriorityFeePerGas: '1000000000', keyVersion: '1' },
      evmNonce: '9',
      vaultAddress: VAULT,
    });
    // After the take, Bridge back is still offered: only the coin the wallet holds can be withdrawn
    // (audit C13), so a mistaken "taken" report can never strand the paid token.
    const back = (await (await get(h, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=bridge-back`, token)).json()) as {
      colour: string;
      amount: string;
    };
    expect(back).toMatchObject({ colour: BID.pay.token.midnightColour, amount: BID.pay.amount.toString() });
    await expectError(await get(h, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=nope`, token), 400, 'bad-request');
  });

  it('refuses a wrong amount, destination, colour, refund recipient, gas; extra calls; another coin; another contract', async () => {
    const { s, token } = await takenSwap(h);
    const provedBefore = h.prover.proved.length;
    const cases: [string, ReturnType<typeof withdrawFor>, string][] = [
      ['wrong amount', withdrawFor(h, s, 'swap', { amount: 999_999n }), 'wrong-call'],
      ['wrong destination', withdrawFor(h, s, 'swap', { dest: newWallet().address }), 'wrong-call'],
      [
        'wrong colour',
        withdrawFor(h, s, 'swap', { colour: tok('stkB').midnightColour, erc20: tok('stkB').sepoliaAddress }),
        'wrong-call',
      ],
      ['wrong refund recipient', withdrawFor(h, s, 'swap', { refund: hex32('elsewhere') }), 'wrong-call'],
      ['wrong gas', withdrawFor(h, s, 'swap', { gasLimit: 900_000n }), 'wrong-call'],
    ];
    for (const [, w] of cases) {
      await expectError(await proveWithdraw(h, s, token, w, 'swap'), 422, 'invalid-tx', 'wrong-call');
    }
    const ok = withdrawFor(h, s, 'swap');
    const extra = { ...ok, tx: { ...ok.tx, calls: [...ok.calls, ok.calls[0]!] } };
    extra.tx.callsDigest = 'x';
    await expectError(await proveWithdraw(h, s, token, extra, 'swap'), 422, 'invalid-tx', 'extra-calls');
    const anotherCoin = { ...ok, tx: { ...ok.tx, imbalances: { '0': { [tok('stkC').midnightColour]: 5n } } } };
    await expectError(await proveWithdraw(h, s, token, anotherCoin, 'swap'), 422, 'invalid-tx', 'another-colour');
    const foreign = {
      ...ok,
      tx: { ...ok.tx, calls: [{ ...ok.calls[0]!, address: 'ee'.repeat(32) }, ok.calls[1]!] },
    };
    await expectError(await proveWithdraw(h, s, token, foreign, 'swap'), 422, 'invalid-tx', 'wrong-contract');
    const entry = {
      ...ok,
      tx: { ...ok.tx, calls: [{ ...ok.calls[0]!, entryPoint: 'completeWithdraw' }, ok.calls[1]!] },
    };
    await expectError(await proveWithdraw(h, s, token, entry, 'swap'), 422, 'invalid-tx', 'wrong-entry-point');
    const dust = { ...ok, tx: { ...ok.tx, dust: true } };
    await expectError(await proveWithdraw(h, s, token, dust, 'swap'), 422, 'invalid-tx', 'dust');
    // an EVM nonce already used on Sepolia
    await expectError(
      await proveWithdraw(h, s, token, withdrawFor(h, s, 'swap', { evmNonce: 8n }), 'swap'),
      409,
      'stale-evm-nonce',
    );
    expect(h.prover.proved).toHaveLength(provedBefore);
    // a take is not a withdrawal
    await expectError(
      await post(
        h,
        SWAP_PATHS.prove(s.swapId),
        { purpose: 'withdraw', tx: txHex(bidTake()), coinNonce: hex32('c'), evmNonce: '9' },
        token,
      ),
      422,
      'invalid-tx',
    );
  });

  it('proves, then withdraws in the background: DUST, the lane, the relayer, completeWithdraw → done (swapped)', async () => {
    const { s, token } = await takenSwap(h);
    const w = withdrawFor(h, s, 'swap');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    const res = await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { swap: SwapView }).swap.state).toBe('withdrawing');
    await h.swaps.idle();
    const v = await view(h, s, token);
    expect(v).toMatchObject({ state: 'done', outcome: 'swapped', takeTx: hex32('take-tx') });
    expect(v.withdraw).toMatchObject({
      kind: 'swap',
      stage: 'completed',
      attested: 'success',
      refunds: 0,
      amount: '1000000',
    });
    expect(v.withdraw!.requestId).toMatch(/^[0-9a-f]{64}$/);
    expect(v.withdraw!.sepoliaTx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(v.withdraw!.completeTx).toMatch(/^[0-9a-f]{64}$/);
    expect(h.vault.settles.at(-1)).toMatchObject({
      circuit: 'completeWithdraw',
      coinPk: s.payload.tempCoinPk,
      encPk: s.payload.tempEncPk,
    });
    expect(v.withdraw!.stages.map((x) => x.stage)).toEqual([
      'queued',
      'starting',
      'submitting',
      'started',
      'mpc-signed',
      'evm-broadcast',
      'evm-final',
      'attested',
      'completing',
      'completed',
    ]);
  });

  it('refuses /withdraw without the matching /prove, a different transaction, or one with DUST added', async () => {
    const { s, token } = await takenSwap(h);
    const w = withdrawFor(h, s, 'swap');
    await expectError(await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token), 409, 'not-proven');
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    const other = withdrawFor(h, s, 'swap', { coinNonce: hex32('another-coin') });
    await expectError(await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(other.tx) }, token), 409, 'not-proven');
    // DUST added: not the transaction /prove validated (P4.2-fix2 R1: compared in full).
    await expectError(
      await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex({ ...w.tx, dust: true }) }, token),
      409,
      'not-proven',
    );
    await expectError(
      await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex({ ...w.tx, unshielded: true }) }, token),
      409,
      'not-proven',
    );
    expect(h.vault.submitted).toHaveLength(0);
    // still usable
    const hold = gate();
    h.vault.defaultRelay = { beforeBroadcast: hold.promise };
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token)).status).toBe(202);
    await expectError(
      await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token),
      409,
      'withdrawal-in-progress',
    );
    hold.open();
    await h.swaps.idle();
  });

  it('a refund (the transfer never executed, e.g. a nonce collision) returns the swap to minted; the retry completes', async () => {
    const { s, token } = await takenSwap(h);
    const w = withdrawFor(h, s, 'swap');
    await proveWithdraw(h, s, token, w);
    h.vault.defaultRelay = { kind: 'never-executed' };
    await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
    await h.swaps.idle();
    let v = await view(h, s, token);
    expect(v.state).toBe('minted');
    expect(v.withdraw).toMatchObject({ stage: 'refunded', attested: 'never-executed' });
    expect(h.vault.settles.at(-1)!.circuit).toBe('refundWithdraw');
    // the app rebuilds on the vault's new state and retries
    h.vault.defaultRelay = {};
    const again = withdrawFor(h, s, 'swap', { coinNonce: hex32('retry') });
    expect((await proveWithdraw(h, s, token, again, 'swap')).status).toBe(200);
    expect((await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(again.tx) }, token)).status).toBe(202);
    await h.swaps.idle();
    v = await view(h, s, token);
    expect(v).toMatchObject({ state: 'done', outcome: 'swapped' });
    expect(v.withdraw!.refunds).toBe(1);
    expect(v.withdrawals).toHaveLength(2);
  });

  it('a vault that moved between /prove and /withdraw: nothing is paid, back to minted with stale-vault-state', async () => {
    const { s, token } = await takenSwap(h);
    const w = withdrawFor(h, s, 'swap');
    await proveWithdraw(h, s, token, w);
    h.vault.version++; // another request landed in the vault
    await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
    await h.swaps.idle();
    const v = await view(h, s, token);
    expect(v.state).toBe('minted');
    expect(v.withdraw!.error).toMatchObject({ code: 'stale-vault-state' });
    expect(h.vault.submitted).toHaveLength(0);
  });

  it('Bridge back: the paid token back to the user when the offer is gone', async () => {
    const { s, token } = await mintedSwap(h);
    const params = (await (await get(h, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=bridge-back`, token)).json()) as {
      colour: string;
      amount: string;
    };
    expect(params).toMatchObject({ colour: BID.pay.token.midnightColour, amount: '104166667' });
    const w = withdrawFor(h, s, 'bridge-back');
    // the page does not name the kind: the sponsor infers it
    expect((await proveWithdraw(h, s, token, w)).status).toBe(200);
    const res = await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(w.tx) }, token);
    expect(((await res.json()) as { swap: SwapView }).swap.state).toBe('bridging_back');
    await h.swaps.idle();
    expect(await view(h, s, token)).toMatchObject({ state: 'done', outcome: 'bridged-back' });
  });

  it('refuses a withdrawal of the swap’s token for the pay amount; a pay-token withdrawal after the take is Bridge back', async () => {
    const { s, token } = await takenSwap(h);
    const mixed = withdrawFor(h, s, 'swap', { amount: BID.pay.amount });
    await expectError(await proveWithdraw(h, s, token, mixed), 422, 'invalid-tx', 'wrong-call');
    await expectError(await proveWithdraw(h, s, token, mixed, 'swap'), 422, 'invalid-tx', 'wrong-call');
    // The pay token after a take report: accepted as Bridge back (audit C13); the vault only
    // accepts it with a coin the temporary wallet really holds.
    expect((await proveWithdraw(h, s, token, withdrawFor(h, s, 'bridge-back'), 'bridge-back')).status).toBe(200);
  });
});

describe('the ONE withdrawal lane (the vault account’s nonce)', () => {
  async function twoTaken() {
    const a = await takenSwap(h, bidSwap(h, newWallet(), 'lane-a'));
    const b = await takenSwap(h, bidSwap(h, newWallet(), 'lane-b'));
    return { a, b };
  }

  it('no two starts share a nonce: a second withdrawal built on the same nonce is refused (stale), rebuilt, and goes next', async () => {
    const { a, b } = await twoTaken();
    const wa = withdrawFor(h, a.s, 'swap', { coinNonce: hex32('a') });
    const wb = withdrawFor(h, b.s, 'swap', { coinNonce: hex32('b') });
    expect(wa.evmNonce).toBe(9n);
    expect(wb.evmNonce).toBe(9n);
    await proveWithdraw(h, a.s, a.token, wa);
    await proveWithdraw(h, b.s, b.token, wb);
    const hold = gate();
    h.vault.defaultRelay = { beforeBroadcast: hold.promise };
    await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token);
    await post(h, SWAP_PATHS.withdraw(b.s.swapId), { tx: txHex(wb.tx) }, b.token);
    // a's start holds nonce 9 from the moment it lands (its persisted reservation) and frees the lane
    // at once; b, signed for 9 too, is refused at the head before anything is paid (audit C2, C3)
    await new Promise((r) => setTimeout(r, 20));
    expect(h.swaps.lanes().withdrawal).toEqual({ running: 0, waiting: 0 });
    expect(h.vault.submitted).toHaveLength(1);
    expect(h.store.get(b.s.swapId)!.state).toBe('minted');
    expect(h.store.get(b.s.swapId)!.withdrawals.at(-1)!.error!.code).toBe('stale-evm-nonce');
    hold.open();
    await h.swaps.idle();
    expect(h.store.get(a.s.swapId)!.state).toBe('done');
    expect(h.vault.startNonces.filter((x) => x.kind === 'withdraw').map((x) => x.nonce)).toEqual([9n]);
    // b rebuilds on the next nonce and goes
    h.vault.defaultRelay = {};
    const p = (await (await get(h, `${SWAP_PATHS.withdrawParams(b.s.swapId)}?kind=swap`, b.token)).json()) as {
      evmNonce: string;
    };
    expect(p.evmNonce).toBe('10');
    const wb2 = withdrawFor(h, b.s, 'swap', { coinNonce: hex32('b2'), evmNonce: 10n });
    expect((await proveWithdraw(h, b.s, b.token, wb2)).status).toBe(200);
    await post(h, SWAP_PATHS.withdraw(b.s.swapId), { tx: txHex(wb2.tx) }, b.token);
    await h.swaps.idle();
    expect(h.store.get(b.s.swapId)!.state).toBe('done');
    const nonces = h.vault.startNonces.filter((x) => x.kind === 'withdraw').map((x) => x.nonce);
    expect(nonces).toEqual([9n, 10n]);
    expect(new Set(nonces).size).toBe(nonces.length);
  });

  it('withdraw-params promises the next nonce while a started transfer is not mined; that withdrawal starts at once', async () => {
    const { a, b } = await twoTaken();
    const wa = withdrawFor(h, a.s, 'swap', { coinNonce: hex32('a') });
    await proveWithdraw(h, a.s, a.token, wa);
    const hold = gate();
    const attest = gate();
    h.vault.defaultRelay = { beforeBroadcast: hold.promise, beforeAttest: attest.promise };
    await post(h, SWAP_PATHS.withdraw(a.s.swapId), { tx: txHex(wa.tx) }, a.token);
    await new Promise((r) => setTimeout(r, 20));
    const p = (await (await get(h, `${SWAP_PATHS.withdrawParams(b.s.swapId)}?kind=swap`, b.token)).json()) as {
      evmNonce: string;
    };
    expect(p.evmNonce).toBe('10');
    // b builds on the vault state a's start left behind
    const wb = withdrawFor(h, b.s, 'swap', { coinNonce: hex32('b'), evmNonce: 10n });
    expect((await proveWithdraw(h, b.s, b.token, wb)).status).toBe(200);
    await post(h, SWAP_PATHS.withdraw(b.s.swapId), { tx: txHex(wb.tx) }, b.token);
    await new Promise((r) => setTimeout(r, 20));
    // a's start holds nonce 9; the lane is free, so b starts with 10 before a's transfer is mined
    expect(h.vault.submitted).toHaveLength(2);
    hold.open();
    await new Promise((r) => setTimeout(r, 20));
    const order = h.vault.log.filter((l) => l.startsWith('broadcast withdraw') || l.startsWith('startWithdraw'));
    expect(order[0]).toMatch(/^startWithdraw nonce=9/);
    expect(order[1]).toMatch(/^startWithdraw nonce=10/);
    expect(order.slice(2).every((l) => l.startsWith('broadcast withdraw'))).toBe(true);
    attest.open();
    await h.swaps.idle();
    expect(h.store.get(a.s.swapId)!.state).toBe('done');
    expect(h.store.get(b.s.swapId)!.state).toBe('done');
    expect(h.vault.startNonces.filter((x) => x.kind === 'withdraw').map((x) => x.nonce)).toEqual([9n, 10n]);
  });
});

describe('the state machine through the routes', () => {
  it('refuses calls in the wrong state', async () => {
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    await expectError(
      await get(h, `${SWAP_PATHS.withdrawParams(s.swapId)}?kind=swap`, o.swapToken),
      409,
      'wrong-state',
    );
    await expectError(
      await post(h, SWAP_PATHS.take(s.swapId), { outcome: 'taken', takeTx: hex32('x') }, o.swapToken),
      409,
      'wrong-state',
    );
    await expectError(
      await post(h, SWAP_PATHS.withdraw(s.swapId), { tx: txHex(bidTake()) }, o.swapToken),
      409,
      'wrong-state',
    );
  });
});

describe('rate limits on proofs', () => {
  it('limits proofs per swap per minute', async () => {
    const hh = harness({ config: testConfig({ RATE_LIMIT_PROVES_PER_SWAP_PER_MIN: '2' }) });
    const { s, token } = await mintedSwap(hh);
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await proveTake(hh, s, token)).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});

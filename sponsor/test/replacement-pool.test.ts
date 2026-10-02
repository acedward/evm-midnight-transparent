// R2 against a REAL transaction pool (plan 00048 P4.2-fix2; audit R2 / F-B22). Skipped unless
// EVM_DEV_RPC_URL names a geth dev node: scripts/replacement-pool-check.sh starts one in Docker, runs
// this file in the check runner, and removes it (CI does not run it).
//
// A transfer from an account standing for the vault's EVM account is signed with the sponsor's
// policy tip (1 gwei) and a fee cap under base fee + tip (the sponsor's "stuck" rule): the pool keeps
// it and no block takes it. (On a dev node the base fee falls with every empty block until a pending
// transfer fits, so the node is started with a miner minimum tip of 1.1 gwei: that is what holds the
// transfer here, as a base fee above its cap does on Sepolia. The pool's replacement rule, geth's
// `txpool.pricebump` of 10% on BOTH fee fields, is the one Sepolia's nodes apply.) The sponsor's own
// sizing (SwapService.withdrawParams, with the persisted reservation of that nonce, signed 35 minutes
// ago) gives the replacement's fee fields; a transfer signed with them (as the MPC signs a vault
// request's fields) is ACCEPTED by the pool and mined, and the stuck one never is. The same pool
// refuses a replacement that raises only `maxFeePerGas` (what the sponsor handed out before this
// fix, keeping the 1 gwei tip): "replacement transaction underpriced".

import { JsonRpcProvider, Transaction, Wallet, parseEther, type TransactionRequest } from 'ethers';
import { describe, expect, it } from 'vitest';

import { jsonRpcEvmReader } from '../src/bridge/evm.js';
import type { EvmReader } from '../src/swaps/backend.js';
import type { SwapRecord } from '../src/swaps/model.js';
import { FakeVault } from './fakes.js';
import { BID, harness, hex32, testConfig } from './harness.js';

const RPC = process.env.EVM_DEV_RPC_URL;
const GWEI = 1_000_000_000n;
const MINUTE = 60_000;

/** A fake vault whose EVM side is the dev node, paid from `account` (the fields are the base
 *  class's own properties, so they are redefined on the instance). */
function poolVault(evm: EvmReader, account: string): FakeVault {
  const v = new FakeVault();
  Object.defineProperty(v, 'evm', { value: evm });
  Object.defineProperty(v, 'vaultEvmAddress', { value: account });
  return v;
}

/** A swap record in `state`, as the store keeps it (only what withdraw-params reads). */
function record(tag: string, state: SwapRecord['state'], nowS: number): SwapRecord {
  const leg = (t: typeof BID.pay) => ({
    colour: t.token.midnightColour,
    amount: t.amount.toString(),
    symbol: t.token.symbol,
    erc20Address: t.token.sepoliaAddress,
    decimals: t.token.decimals,
  });
  return {
    v: 1,
    swapId: hex32(`pool-${tag}`),
    evmAddress: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
    offerId: BID.offerId,
    pay: leg(BID.pay),
    receive: leg(BID.receive),
    tempCoinPk: hex32(`coin-${tag}`),
    tempEncPk: hex32(`enc-${tag}`),
    depositAddress: '0x0000000000000000000000000000000000000001',
    sweepGas: { gasLimit: '65000', maxFeePerGas: '1', maxPriorityFeePerGas: '1', ethWei: '65000' },
    tokenHash: 'x',
    state,
    deposit: { stage: 'completed', stages: [], attempts: 1 },
    takeTx: hex32('take'),
    proofs: { take: 1, withdraw: 0 },
    provenWithdraw: null,
    withdrawals: [],
    history: [{ state, at: nowS }],
    createdAt: nowS,
    updatedAt: nowS,
  };
}

describe.skipIf(!RPC)('R2 on a real transaction pool (geth --dev)', () => {
  it('the sponsor’s replacement of a stuck transfer is accepted by the pool and mined; a fee-cap-only bump is refused', async () => {
    const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, pollingInterval: 250 });
    const { chainId } = await provider.getNetwork();
    const dev = await provider.getSigner(0);
    const account = Wallet.createRandom().connect(provider);
    await (
      await dev.sendTransaction({
        to: account.address,
        value: parseEther('1'),
        maxPriorityFeePerGas: 2n * GWEI,
        maxFeePerGas: 10n * GWEI,
      })
    ).wait();

    // The stuck transfer: nonce 0, the policy's 1 gwei tip, a 1 gwei cap (< base fee + tip).
    const base0 = (await provider.getBlock('latest'))!.baseFeePerGas!;
    const stuck = { maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI };
    const tx = (over: Partial<TransactionRequest>): TransactionRequest => ({
      type: 2,
      chainId,
      to: account.address,
      value: 0n,
      nonce: 0,
      gasLimit: 21_000n,
      ...over,
    });
    const stuckSigned = await account.signTransaction(tx(stuck));
    const stuckHash = Transaction.from(stuckSigned).hash!;
    await provider.broadcastTransaction(stuckSigned);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await provider.getTransactionReceipt(stuckHash)).toBeNull();
    expect(await provider.getTransactionCount(account.address, 'latest')).toBe(0);
    expect(await provider.getTransactionCount(account.address, 'pending')).toBe(1);

    // The sponsor, with the stuck transfer as a started, signed, persisted reservation of nonce 0.
    const vault = poolVault(jsonRpcEvmReader(RPC!), account.address);
    const h = harness({
      vault,
      config: testConfig({
        BRIDGE_EVM_MAX_FEE_PER_GAS: GWEI.toString(), // a 1 gwei floor (the dev node's base fee is under 1 gwei)
        BRIDGE_EVM_MAX_PRIORITY_FEE_PER_GAS: GWEI.toString(), // the production tip
      }),
    });
    const nowS = Math.floor(h.now.ms / 1000);
    const a = record('a', 'withdrawing', nowS);
    a.withdrawals.push({
      kind: 'swap',
      colour: a.receive.colour,
      amount: a.receive.amount,
      stage: 'mpc-signed',
      stages: [],
      refunds: 0,
      evmNonce: '0',
      coinNonce: hex32('coin-nonce-a'),
      requestId: hex32('request-a'),
      gas: {
        gasLimit: '21000',
        maxFeePerGas: stuck.maxFeePerGas.toString(),
        maxPriorityFeePerGas: stuck.maxPriorityFeePerGas.toString(),
      },
      startedAtMs: h.now.ms - 40 * MINUTE,
      signedAtMs: h.now.ms - 35 * MINUTE,
      signedTxHash: stuckHash,
    });
    const b = record('b', 'taken', nowS);
    h.store.put(a);
    h.store.put(b);

    const params = await h.swaps.withdrawParams(h.store.get(b.swapId)!, 'swap');
    expect(params.evmNonce).toBe('0'); // the replacement
    const fee = BigInt(params.gas.maxFeePerGas);
    const tip = BigInt(params.gas.maxPriorityFeePerGas);

    // The pool's rule: raising only the fee cap is refused (what the sponsor handed out before this fix).
    const capOnly = await account.signTransaction(
      tx({ maxFeePerGas: fee, maxPriorityFeePerGas: stuck.maxPriorityFeePerGas }),
    );
    await expect(provider.broadcastTransaction(capOnly)).rejects.toThrow(/replacement transaction underpriced/);

    // The sponsor's replacement, as the MPC would sign it: accepted and mined; the stuck one never is.
    const replacement = await account.signTransaction(tx({ maxFeePerGas: fee, maxPriorityFeePerGas: tip }));
    const sent = await provider.broadcastTransaction(replacement);
    expect(tip * 100n).toBeGreaterThanOrEqual(stuck.maxPriorityFeePerGas * 110n);
    expect(fee * 100n).toBeGreaterThanOrEqual(stuck.maxFeePerGas * 110n);
    const receipt = await sent.wait(1, 30_000);
    expect(receipt?.status).toBe(1);
    // The dev node indexes the receipt a moment before it moves its head: read the nonce until then.
    let mined = 0;
    for (let i = 0; i < 40 && mined === 0; i++) {
      mined = await provider.getTransactionCount(account.address, 'latest');
      if (mined === 0) await new Promise((r) => setTimeout(r, 250));
    }
    expect(mined).toBe(1);
    expect(await provider.getTransactionReceipt(stuckHash)).toBeNull();
    expect(await provider.getTransaction(stuckHash)).toBeNull(); // replaced: gone from the pool
    console.log(
      JSON.stringify({
        chainId: chainId.toString(),
        baseFeeWei: base0.toString(),
        stuck: {
          hash: stuckHash,
          maxFeePerGas: stuck.maxFeePerGas.toString(),
          tip: stuck.maxPriorityFeePerGas.toString(),
        },
        sponsorReplacement: { nonce: params.evmNonce, maxFeePerGas: fee.toString(), tip: tip.toString() },
        capOnlyRefused: true,
        replacementMined: { hash: receipt!.hash, block: receipt!.blockNumber, status: receipt!.status },
      }),
    );
    provider.destroy();
  }, 60_000);
});

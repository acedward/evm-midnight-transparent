// The sponsor's own build of a swap's `startWithdraw`: the call the temporary wallet must have built,
// from the swap's values (ERC20, amount, the user's EVM address, the temporary wallet as refund
// recipient, the gas policy) and the browser's two public hints (the coin nonce, the EVM nonce), on
// the vault's state at one block. Nothing is proven or sent, and no key material is read.
//
// It is built exactly as the wallet builds it (packages/wallet/src/withdraw.ts `buildWithdraw`):
// midnight-js 5.0.0-beta.7 `createUnprovenCallTxFromInitialStates` over the vault's state, its Zswap
// tree and the ledger parameters at ONE block, then the callee's state at the same block. The two
// calls' public transcripts (../validate/summary.ts digests) are what the refusal rule compares;
// sponsor/test/rebuild-wallet.test.ts checks this against the wallet's own build on recorded stagenet
// state, and `sponsor/src/tools/vault-keys.ts rebuild-check` against the live vault.

import { hexToBytes, walletRecipient } from '@evm-midnight-transparent/core';

import type { RebuiltWithdraw, WithdrawCallArgs } from '../swaps/backend.js';
import { summarise } from '../validate/inspect.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** The chain reads a rebuild needs (midnight-js's indexer public-data provider, or a fixture). */
export interface VaultStateReader {
  queryBlock(config?: Any): Promise<{ hash: string; height: number } | null>;
  queryZSwapAndContractState(address: string, config?: Any): Promise<[Any, Any, Any] | null>;
  queryContractState(address: string, config?: Any): Promise<Any | null>;
}

/** The compiled vault as the rebuild uses it: its contract, and its ledger reader. */
export interface RebuildRuntime {
  compiledContract: Any;
  ledger(state: unknown): Any;
}

/** Building a call reads no key material: a provider that throws on any key read. */
const NO_KEY_MATERIAL = (() => {
  const refuse = () => {
    throw new Error('a rebuild reads no key material');
  };
  return {
    getProverKey: refuse,
    getVerifierKey: refuse,
    getVerifierKeys: refuse,
    getZKIR: refuse,
    get: refuse,
    asKeyMaterialProvider: refuse,
  };
})();

const norm = (h: unknown) => String(h).replace(/^0x/i, '').toLowerCase();

export async function rebuildStartWithdraw(
  rt: RebuildRuntime,
  reader: VaultStateReader,
  vault: string,
  a: WithdrawCallArgs,
): Promise<RebuiltWithdraw & { block: { hash: string; height: number }; request: unknown }> {
  const { createUnprovenCallTxFromInitialStates } = await import('@midnight-ntwrk/midnight-js-contracts');
  const block = await reader.queryBlock();
  if (!block) throw new Error('the indexer returned no block');
  const states = await reader.queryZSwapAndContractState(vault, { type: 'blockHash', blockHash: block.hash });
  if (!states) throw new Error(`no vault state at ${vault}`);
  const [zswapChainState, contractState, ledgerParameters] = states;
  const call: Any = await (createUnprovenCallTxFromInitialStates as Any)(
    NO_KEY_MATERIAL,
    {
      compiledContract: rt.compiledContract,
      contractAddress: vault,
      circuitId: 'startWithdraw',
      args: [
        a.evmNonce,
        a.gas.gasLimit,
        a.gas.maxFeePerGas,
        a.gas.maxPriorityFeePerGas,
        a.gas.keyVersion,
        hexToBytes(a.erc20, 20),
        a.amount,
        hexToBytes(a.dest, 20),
        { nonce: hexToBytes(a.coinNonce, 32), color: hexToBytes(a.colour, 32), value: a.amount },
        walletRecipient(a.refundCoinPk),
      ],
      coinPublicKey: a.tempCoinPk,
      initialContractState: contractState,
      initialZswapChainState: zswapChainState,
      ledgerParameters,
    },
    a.tempEncPk,
    { publicDataProvider: reader, blockHash: block.hash },
  );
  const s = summarise(call.private.unprovenTx);
  // The request the call creates: the vault stores it under its request nonce, then increments it.
  const next = rt.ledger(call.public.nextContractState);
  const requestNonce = BigInt(next.signetRequestNonce) - 1n;
  const ours: [string, unknown][] = [];
  for (const [k, v] of next.withdrawEventMap as Iterable<[Uint8Array, Any]>) {
    if (BigInt(v.requestNonce) === requestNonce) ours.push([norm(Buffer.from(k).toString('hex')), v]);
  }
  if (ours.length !== 1) throw new Error(`expected one new withdraw request, found ${ours.length}`);
  return { calls: s.calls, callsDigest: s.callsDigest, requestId: ours[0]![0], block, request: ours[0]![1] };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

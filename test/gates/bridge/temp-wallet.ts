// The swap's temporary Midnight wallet, as the G-BRIDGE gate drives it.
//
// The derivation is plan T.1's (G-TAKE, merged from be17749): `deriveSwapSeed` signs the EIP-712
// "start swap" message twice (spec v1 in packages/core/src/swap-key.ts), `temporaryWalletKeys`
// derives the keys the standard HD way, and `openShieldedWallet` runs the shielded sub-wallet
// alone (packages/wallet). This file adds what G-BRIDGE needs on top: the Sepolia user as a local
// signer, a strict sync wait, and the temporary wallet's own `startWithdraw` builder (which L-WALLET
// moves into packages/wallet).
//
// THE KEY never leaves this process: it is never printed, logged, written or sent anywhere except
// inside the proof requests to our own proof server (spec Q3 A). What this module hands the gate
// is public: the coin and encryption public keys.

import { type ethers } from 'ethers';
import * as Rx from 'rxjs';

import { deriveSwapSeed, type StartSwapSigner } from '@evm-midnight-transparent/core';
import {
  openShieldedWallet,
  temporaryWalletKeys,
  type OpenedShieldedWallet,
  type TemporaryWalletKeys,
} from '@evm-midnight-transparent/wallet';

import { type VaultRuntime } from '../../../sponsor/src/bridge/vault.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface DerivedTemp {
  keys: TemporaryWalletKeys;
  deterministic: boolean;
  signer: string;
  prompts: number;
}

/** "Start swap", signed twice by `evm` (a local key standing in for the user's wallet), and the
 *  temporary wallet's keys from the first signature. */
export async function deriveTemp(
  evm: ethers.Wallet,
  p: { network: string; vault: string; salt: string },
): Promise<DerivedTemp> {
  let prompts = 0;
  const sign: StartSwapSigner = async (td) => {
    prompts += 1;
    const { EIP712Domain: _domain, ...types } = td.types;
    return evm.signTypedData(td.domain, types, td.message);
  };
  const out = await deriveSwapSeed(sign, p, evm.address);
  return {
    keys: temporaryWalletKeys(out.seedHex, p.network),
    deterministic: out.deterministic,
    signer: out.signer,
    prompts,
  };
}

export interface OpenTemp {
  opened: OpenedShieldedWallet;
  syncMs: number;
  /** The confirmed balance of `colourHex`, in base units. */
  balance(colourHex: string): Promise<bigint>;
  /** Public descriptions of the available coins. */
  coins(): Promise<{ color: string; value: string; nonce: string }[]>;
  stop(): Promise<void>;
}

/** Open the shielded sub-wallet only, and wait until it has strictly caught up with the chain. */
export async function openTemp(
  keys: TemporaryWalletKeys,
  e: { networkId: string; indexerUrl: string; indexerWsUrl: string },
  log: (s: string) => void,
): Promise<OpenTemp> {
  if (!('WebSocket' in globalThis)) {
    const { WebSocket } = await import('ws');
    (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
  }
  const t0 = Date.now();
  const opened = await openShieldedWallet(keys.shieldedSecretKeys, e);
  let last = 0;
  const unsub = opened.onProgress((p) => {
    if (Date.now() - last > 15_000) {
      last = Date.now();
      log(`      temporary wallet sync: ${p.appliedIndex} / ${p.latestIndex}`);
    }
  });
  await Rx.firstValueFrom(
    (opened.wallet.state as unknown as Rx.Observable<Any>).pipe(Rx.filter((s: Any) => s.progress.isStrictlyComplete())),
  );
  unsub();
  const syncMs = Date.now() - t0;
  const norm = (h: unknown) => String(h).replace(/^0x/, '').toLowerCase();
  return {
    opened,
    syncMs,
    async balance(colourHex) {
      return (await opened.balances())[norm(colourHex)] ?? 0n;
    },
    async coins() {
      const s: Any = await Rx.firstValueFrom(opened.wallet.state as unknown as Rx.Observable<Any>);
      return (s.availableCoins as Any[]).map((c: Any) => ({
        color: norm(c.coin.type),
        value: String(c.coin.value),
        nonce: norm(c.coin.nonce),
      }));
    },
    stop: () => opened.stop(),
  };
}

/**
 * The temporary wallet's own `startWithdraw`: built against the vault's current state, balanced on
 * its SHIELDED side only (the wallet spends its vault coin into the contract-owned output the
 * circuit's `receiveShielded` expects), proven on the proof server, and bound. No DUST: the sponsor
 * adds it. Returns the finalized transaction and the call's next contract state (which names the
 * request the call creates).
 */
export async function buildStartWithdraw(
  rt: VaultRuntime,
  temp: OpenTemp,
  keys: TemporaryWalletKeys,
  deps: { publicDataProvider: Any; proofProvider: Any },
  input: {
    vault: string;
    evmNonce: bigint;
    gas: { gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; keyVersion: bigint };
    erc20: Uint8Array;
    amount: bigint;
    dest: Uint8Array;
    colour: Uint8Array;
    coinNonce: Uint8Array;
    refundRecipient: Any;
  },
  log: (s: string) => void,
): Promise<{ finalized: Any; nextContractState: Any; buildMs: number; balanceMs: number; proveMs: number }> {
  const { createUnprovenCallTx } = await import('@midnight-ntwrk/midnight-js-contracts');
  const t0 = Date.now();
  const unsubmitted: Any = await (createUnprovenCallTx as Any)(
    {
      publicDataProvider: deps.publicDataProvider,
      zkConfigProvider: rt.zkConfigProvider,
      walletProvider: {
        getCoinPublicKey: () => keys.coinPublicKey,
        getEncryptionPublicKey: () => keys.encryptionPublicKey,
      },
    },
    {
      compiledContract: rt.compiledContract,
      contractAddress: input.vault,
      circuitId: 'startWithdraw',
      args: [
        input.evmNonce,
        input.gas.gasLimit,
        input.gas.maxFeePerGas,
        input.gas.maxPriorityFeePerGas,
        input.gas.keyVersion,
        input.erc20,
        input.amount,
        input.dest,
        { nonce: input.coinNonce, color: input.colour, value: input.amount },
        input.refundRecipient,
      ],
    },
  );
  const unproven = unsubmitted.private.unprovenTx;
  const buildMs = Date.now() - t0;
  log(`      built the unproven startWithdraw call in ${Math.round(buildMs / 1000)} s`);

  const t1 = Date.now();
  const balancing: Any = await temp.opened.wallet.balanceTransaction(keys.shieldedSecretKeys, unproven);
  if (balancing === undefined) throw new Error('the shielded side needed no balancing: the coin was not spent');
  const merged = unproven.merge(balancing);
  const balanceMs = Date.now() - t1;
  log(`      balanced the shielded side (the temporary wallet alone) in ${balanceMs} ms`);

  const t2 = Date.now();
  const unbound: Any = await deps.proofProvider.proveTx(merged);
  const finalized = unbound.bind();
  const proveMs = Date.now() - t2;
  log(`      proved on the proof server in ${Math.round(proveMs / 1000)} s`);
  return { finalized, nextContractState: unsubmitted.public.nextContractState, buildMs, balanceMs, proveMs };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

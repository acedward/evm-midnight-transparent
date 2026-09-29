// The swap's temporary Midnight wallet, as the G-BRIDGE gate drives it: derived from the user's
// EIP-712 "start swap" signature, shielded only, and able to build its own `startWithdraw`.
//
// DERIVATION (plan T.1's spec, implemented here until G-TAKE's core module is merged; then this
// file imports it instead): the user's EVM wallet signs the EIP-712 message
//   domain  { name: "EVM Midnight Swap", version: "1", chainId: 11155111 }
//   StartSwap { string purpose; string network; bytes32 vault; bytes32 salt }
// twice; the two signatures must be equal (a deterministic signer), and the wallet seed is
// keccak256(signature). The Midnight keys come from that seed the way every Midnight wallet derives
// them (HD account 0, role Zswap, index 0). Only the shielded sub-wallet is opened.
//
// THE KEY never leaves this process: it is never printed, logged, written or sent anywhere except
// inside the proof requests to our own proof server (spec Q3 A). What this module returns to the
// gate is public: the coin and encryption public keys.

import { ethers } from 'ethers';
import * as Rx from 'rxjs';

import { type VaultRuntime } from '../../../sponsor/src/bridge/vault.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export const START_SWAP_DOMAIN_NAME = 'EVM Midnight Swap';
export const START_SWAP_PURPOSE = 'Start a swap: this signature creates the swap temporary Midnight wallet';

export const START_SWAP_TYPES = {
  StartSwap: [
    { name: 'purpose', type: 'string' },
    { name: 'network', type: 'string' },
    { name: 'vault', type: 'bytes32' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const;

export function startSwapTypedData(input: { chainId: number; network: string; vault: string; salt: string }) {
  return {
    domain: { name: START_SWAP_DOMAIN_NAME, version: '1', chainId: input.chainId },
    types: { StartSwap: [...START_SWAP_TYPES.StartSwap] },
    message: {
      purpose: START_SWAP_PURPOSE,
      network: input.network,
      vault: `0x${input.vault.replace(/^0x/i, '').toLowerCase()}`,
      salt: `0x${input.salt.replace(/^0x/i, '').toLowerCase()}`,
    },
  };
}

export interface TempKeys {
  /** Public: the coin public key (hex, no prefix). */
  coinPublicKeyHex: string;
  /** Public: the encryption public key (hex, no prefix). */
  encryptionPublicKeyHex: string;
  /** SECRET: the zswap secret keys. Never printed. */
  zswap: Any;
  /** Whether the two signatures were equal (a deterministic signer). */
  deterministic: boolean;
}

/** Sign "start swap" twice with `signer`, and derive the temporary wallet's keys from it. */
export async function deriveTempWallet(
  signer: ethers.Signer,
  typed: ReturnType<typeof startSwapTypedData>,
): Promise<TempKeys> {
  const first = await signer.signTypedData(typed.domain, typed.types, typed.message);
  const second = await signer.signTypedData(typed.domain, typed.types, typed.message);
  const seed = ethers.getBytes(ethers.keccak256(first));
  const [ledger, hd] = await Promise.all([import('@midnightntwrk/ledger-v9'), import('@midnightntwrk/wallet-sdk-hd')]);
  const created = hd.HDWallet.fromSeed(seed);
  if (created.type !== 'seedOk') throw new Error('the start-swap seed is not a valid HD seed');
  const derived = created.hdWallet.selectAccount(0).selectRoles([hd.Roles.Zswap]).deriveKeysAt(0);
  created.hdWallet.clear();
  seed.fill(0);
  if (derived.type !== 'keysDerived') throw new Error('temporary wallet key derivation failed');
  const zswap: Any = ledger.ZswapSecretKeys.fromSeed(derived.keys[hd.Roles.Zswap]);
  return {
    coinPublicKeyHex: String(zswap.coinPublicKey).replace(/^0x/, '').toLowerCase(),
    encryptionPublicKeyHex: String(zswap.encryptionPublicKey).replace(/^0x/, '').toLowerCase(),
    zswap,
    deterministic: first === second,
  };
}

const NoopTxHistoryStorage = {
  gotPending: async () => undefined,
  gotFinalized: async () => undefined,
  gotRejected: async () => undefined,
  getAll: async () => [] as unknown[],
  get: async () => undefined,
  serialize: async () => '[]',
};

export interface TempWalletEndpoints {
  networkId: string;
  indexerUrl: string;
  indexerWsUrl: string;
}

export interface OpenTempWallet {
  wallet: Any;
  state(): Promise<Any>;
  /** The available balance of `colourHex`, in base units. */
  balance(colourHex: string): Promise<bigint>;
  stop(): Promise<void>;
  syncMs: number;
}

/** Start the shielded sub-wallet only and wait until it has caught up with the chain. */
export async function openTempShielded(
  keys: TempKeys,
  e: TempWalletEndpoints,
  log: (s: string) => void,
): Promise<OpenTempWallet> {
  const { ShieldedWallet } = await import('@midnightntwrk/wallet-sdk-shielded');
  if (!('WebSocket' in globalThis)) {
    const { WebSocket } = await import('ws');
    (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
  }
  const configuration: Any = {
    networkId: e.networkId,
    indexerClientConnection: { indexerHttpUrl: e.indexerUrl, indexerWsUrl: e.indexerWsUrl },
    txHistoryStorage: NoopTxHistoryStorage,
  };
  const t0 = Date.now();
  const wallet: Any = (ShieldedWallet(configuration) as Any).startWithSecretKeys(keys.zswap);
  await wallet.start(keys.zswap);
  let last = 0;
  await Rx.firstValueFrom(
    (wallet.state as Rx.Observable<Any>).pipe(
      Rx.tap((s: Any) => {
        if (Date.now() - last > 15_000) {
          last = Date.now();
          const p = s.progress;
          log(
            `      temp wallet sync: applied ${String(p?.appliedIndex)} / ${String(p?.highestRelevantWalletIndex ?? p?.highestIndex)}`,
          );
        }
      }),
      Rx.filter((s: Any) => s.progress?.isStrictlyComplete?.() === true),
    ),
  );
  const syncMs = Date.now() - t0;
  const state = () => Rx.firstValueFrom(wallet.state as Rx.Observable<Any>);
  return {
    wallet,
    state,
    async balance(colourHex) {
      const s = await state();
      const want = colourHex.replace(/^0x/, '').toLowerCase();
      for (const [k, v] of Object.entries(s.balances ?? {}))
        if (k.replace(/^0x/, '').toLowerCase() === want) return BigInt(v as bigint);
      return 0n;
    },
    stop: () => wallet.stop(),
    syncMs,
  };
}

/**
 * The temporary wallet's own `startWithdraw`: built against the vault's current state, balanced on
 * its SHIELDED side only (the wallet spends its vault coin into the contract-owned output the
 * circuit's `receiveShielded` expects), proven on the proof server, and bound. No DUST: the sponsor
 * adds it. Returns the finalized transaction and the call's next contract state (to find the
 * request id the call created).
 */
export async function buildStartWithdraw(
  rt: VaultRuntime,
  temp: OpenTempWallet,
  keys: TempKeys,
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
        getCoinPublicKey: () => keys.coinPublicKeyHex,
        getEncryptionPublicKey: () => keys.encryptionPublicKeyHex,
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
  const balancing: Any = await temp.wallet.balanceTransaction(keys.zswap, unproven);
  if (balancing === undefined) throw new Error('the shielded side needed no balancing: the coin was not spent');
  const merged = unproven.merge(balancing);
  const balanceMs = Date.now() - t1;
  log(`      balanced the shielded side (temporary wallet only) in ${balanceMs} ms`);

  const t2 = Date.now();
  const unbound: Any = await deps.proofProvider.proveTx(merged);
  const finalized = unbound.bind();
  const proveMs = Date.now() - t2;
  log(`      proved on the proof server in ${Math.round(proveMs / 1000)} s`);
  return { finalized, nextContractState: unsubmitted.public.nextContractState, buildMs, balanceMs, proveMs };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

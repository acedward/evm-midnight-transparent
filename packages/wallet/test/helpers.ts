// Offline test doubles built from the REAL SDK and ledger, no network:
//   - a temporary wallet whose shielded state holds chosen coins (the SDK's ShieldedWallet restored from
//     a ledger `ZswapLocalState` with `insertCoin`, never started), so `balanceTransaction` runs the
//     SDK's own coin selection;
//   - a vault state reader serving the stagenet state recorded at one block (fixtures/README.md).

import { readFileSync } from 'node:fs';

import {
  deserializeCompactContractState,
  deserializeLedgerParameters,
  deserializeZswapChainState,
} from '@midnight-ntwrk/midnight-js-utils';
import * as ledger from '@midnightntwrk/ledger-v9';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';

import { STAGENET, bytesToHex, hexToBytes, type NetworkProfile } from '@evm-midnight-transparent/core';

import {
  NO_TX_HISTORY,
  createTempWallet,
  wrapShieldedWallet,
  type TempWallet,
  type VaultStateReader,
} from '../src/index.js';

export const WUSDC = 'e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d';
export const WSTKA = '5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02';

/** Test-only seeds (never funded anywhere). */
export const TEST_SEED_A = '11'.repeat(32);
export const TEST_SEED_B = '22'.repeat(32);

export const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
export const fixtureText = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').trim();

/** A temporary wallet for `seed` whose shielded state holds exactly `coins` (colour → values). */
export async function walletWithCoins(
  seed: string,
  coins: { colour: string; value: bigint }[],
  profile: NetworkProfile = STAGENET,
): Promise<TempWallet> {
  return createTempWallet(seed, {
    profile,
    openWallet: async (keys, endpoints) => {
      const W = ShieldedWallet({
        networkId: endpoints.networkId,
        indexerClientConnection: {
          indexerHttpUrl: 'http://127.0.0.1:9/unused',
          indexerWsUrl: 'ws://127.0.0.1:9/unused',
        },
        txHistoryStorage: NO_TX_HISTORY,
      } as never);
      const sk = keys.shieldedSecretKeys;
      const empty = W.startWithSecretKeys(sk);
      const snapshot = JSON.parse(await empty.serializeState()) as Record<string, unknown>;
      await empty.stop();
      let state = new ledger.ZswapLocalState();
      for (const c of coins) state = state.insertCoin(sk, ledger.createShieldedCoinInfo(c.colour, c.value));
      const coinHashes: Record<string, { commitment: string; nullifier: string }> = {};
      for (const c of state.coins) {
        coinHashes[c.nonce] = {
          commitment: ledger.coinCommitment(c, sk.coinPublicKey),
          nullifier: ledger.coinNullifier(c, sk.coinSecretKey),
        };
      }
      snapshot.state = bytesToHex(state.serialize());
      snapshot.coinHashes = coinHashes;
      return wrapShieldedWallet(W.restore(JSON.stringify(snapshot)) as never);
    },
  });
}

export interface VaultFixture {
  block: { height: number; hash: string; timestamp: number };
  vault: { address: string; state: string; contractZswapState: string; ledgerParameters: string };
  singleton: { address: string; state: string };
}

/** A `VaultStateReader` serving one recorded block; it records what was asked. */
export function fixtureReader(f: VaultFixture): VaultStateReader & { calls: string[] } {
  const ctx = { caller: 'packages/wallet/test' };
  const calls: string[] = [];
  const at = (config: unknown) => {
    const c = config as { type?: string; blockHash?: string } | undefined;
    if (c?.type !== 'blockHash' || c.blockHash !== f.block.hash)
      throw new Error(`unexpected block ${JSON.stringify(c)}`);
  };
  return {
    calls,
    async queryBlock() {
      calls.push('block');
      return { hash: f.block.hash, height: f.block.height };
    },
    async queryZSwapAndContractState(address, config) {
      calls.push(`zswap+contract:${address}`);
      at(config);
      if (address !== f.vault.address) return null;
      return [
        deserializeZswapChainState(hexToBytes(f.vault.contractZswapState), ctx),
        deserializeCompactContractState(hexToBytes(f.vault.state), ctx),
        deserializeLedgerParameters(hexToBytes(f.vault.ledgerParameters), ctx),
      ];
    },
    async queryContractState(address, config) {
      calls.push(`contract:${address}`);
      at(config);
      if (address === f.singleton.address) return deserializeCompactContractState(hexToBytes(f.singleton.state), ctx);
      if (address === f.vault.address) return deserializeCompactContractState(hexToBytes(f.vault.state), ctx);
      return null;
    },
  };
}

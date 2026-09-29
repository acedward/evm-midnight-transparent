// A temporary wallet whose shielded state holds chosen coins, built from the REAL SDK and ledger
// with no network: the SDK's `ShieldedWallet` restored from a ledger `ZswapLocalState` filled with
// `insertCoin`, and never started. `balanceTransaction` then runs the SDK's own coin selection.
// The coins exist only in this state (their Merkle tree is local): a transaction built from them is
// never valid on chain. Browser-safe: the unit tests and the headless-browser page both use it.

import * as ledger from '@midnightntwrk/ledger-v9';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';

import { STAGENET, bytesToHex, type NetworkProfile } from '@evm-midnight-transparent/core';

import { NO_TX_HISTORY, createTempWallet, wrapShieldedWallet, type TempWallet } from '../src/index.js';

/** A temporary wallet for `seed` whose shielded state holds exactly `coins`. */
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

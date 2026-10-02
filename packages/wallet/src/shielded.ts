// The temporary wallet's only sub-wallet: the SHIELDED one (plan research 6).
//
// A swap's wallet holds shielded coins only, so it runs the wallet SDK's ShieldedWallet on its own,
// without the facade (which would also sync the unshielded and DUST wallets it never uses). It
// syncs the chain's shielded events from genesis over the indexer's websocket, keeps the coins
// sealed to this wallet, and balances a transaction's shielded side.
//
// Browser-safe: the SDK talks to the indexer over fetch and WebSocket (the stagenet indexer serves
// CORS), and nothing here is persisted.

import { type ZswapSecretKeys } from '@midnightntwrk/ledger-v9';
import { ShieldedWallet, type ShieldedWalletAPI, type ShieldedWalletState } from '@midnightntwrk/wallet-sdk-shielded';
import { firstValueFrom } from 'rxjs';

export interface ShieldedEndpoints {
  /** The Midnight network id, e.g. "stagenet". */
  networkId: string;
  indexerUrl: string;
  indexerWsUrl: string;
}

/** No transaction history is kept: the swap record lives in the app's own local data. */
export const NO_TX_HISTORY = {
  gotPending: async () => undefined,
  gotFinalized: async () => undefined,
  gotRejected: async () => undefined,
  getAll: async () => [] as unknown[],
  get: async () => undefined,
  serialize: async () => '[]',
};

export interface SyncProgressReport {
  synced: boolean;
  /** The last zswap ledger event the wallet applied, and the indexer's latest (public numbers).
   *  Synced = connected and the two are equal (the SDK's `isStrictlyComplete`). */
  appliedIndex: number;
  latestIndex: number;
}

export interface OpenedShieldedWallet {
  readonly wallet: ShieldedWalletAPI;
  /** Resolves once the wallet has caught up with the chain; the state at that moment. */
  waitSynced(): Promise<ShieldedWalletState>;
  /** Spendable (confirmed) balances by colour (64 lowercase hex), in base units. */
  balances(): Promise<Record<string, bigint>>;
  /** Subscribe to sync progress (public numbers only). Returns the unsubscribe. */
  onProgress(cb: (p: SyncProgressReport) => void): () => void;
  stop(): Promise<void>;
}

/** Open and start the shielded wallet for `secretKeys`. It starts syncing at once. */
export async function openShieldedWallet(
  secretKeys: ZswapSecretKeys,
  endpoints: ShieldedEndpoints,
): Promise<OpenedShieldedWallet> {
  const configuration = {
    networkId: endpoints.networkId,
    indexerClientConnection: { indexerHttpUrl: endpoints.indexerUrl, indexerWsUrl: endpoints.indexerWsUrl },
    txHistoryStorage: NO_TX_HISTORY,
  };
  const wallet = ShieldedWallet(configuration as never).startWithSecretKeys(secretKeys);
  await wallet.start(secretKeys);
  return wrapShieldedWallet(wallet);
}

/** The helpers around an SDK shielded wallet (started, or restored from a state in tests). */
export function wrapShieldedWallet(wallet: ShieldedWalletAPI): OpenedShieldedWallet {
  return {
    wallet,
    waitSynced: () => wallet.waitForSyncedState(),
    async balances() {
      const state = await firstValueFrom(wallet.state);
      const out: Record<string, bigint> = {};
      for (const [colour, value] of Object.entries(state.balances)) {
        out[colour.replace(/^0x/, '').toLowerCase()] = value;
      }
      return out;
    },
    onProgress(cb) {
      const sub = wallet.state.subscribe((s) =>
        cb({
          synced: s.progress.isStrictlyComplete(),
          appliedIndex: Number(s.progress.appliedIndex),
          latestIndex: Number(s.progress.highestRelevantWalletIndex),
        }),
      );
      return () => sub.unsubscribe();
    },
    stop: () => wallet.stop(),
  };
}

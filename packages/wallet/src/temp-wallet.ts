// The swap's temporary Midnight wallet, as the app uses it (plan "Lane contracts", the wallet module).
//
//   const { seed, deterministic } = await deriveSwapSeed(eip1193SwapSigner(provider, account), salt);
//   const wallet = await createTempWallet(seed);          // starts the shielded-only sync
//   await wallet.sync(onProgress);                        // ~20 s from genesis on stagenet (G-TAKE T.5)
//   await wallet.balances();                              // { colour: bigint }
//   ...buildTake / buildWithdraw (take.ts, withdraw.ts)...
//   await wallet.close();                                 // stops the sync and wipes the keys
//
// THE KEY stays in this module's memory: the seed is turned into keys at once, the keys live in a
// module-private WeakMap (never on the object the app holds), and `close()` wipes them. Nothing is
// written to storage, logged or sent anywhere except, inside a proof request, to our own proof
// server (spec Q3 A). Everything the object exposes is public: keys' public halves and addresses.

import {
  type NetworkProfile,
  STAGENET,
  SWAP_KEY_DERIVATION_LATEST,
  deriveSwapSeed as deriveSwapSeedCore,
  swapDepositAddress,
  type StartSwapSigner,
  type SwapKeyDerivation,
} from '@evm-midnight-transparent/core';
import * as Rx from 'rxjs';

import { temporaryWalletKeys, type TemporaryWalletKeys } from './keys.js';
import {
  openShieldedWallet,
  type OpenedShieldedWallet,
  type ShieldedEndpoints,
  type SyncProgressReport,
} from './shielded.js';

export class TempWalletError extends Error {
  override name = 'TempWalletError';
}

// ── The seed ─────────────────────────────────────────────────────────────────

/** Signs EIP-712 typed data as the user's EVM account (`eth_signTypedData_v4`). */
export interface SwapSigner {
  /** The account that must sign (checksummed or not). */
  address: string;
  /** The typed data as `eth_signTypedData_v4` takes it (EIP712Domain included); returns the signature. */
  signTypedData(typedData: Parameters<StartSwapSigner>[0]): Promise<string>;
}

/** An EIP-1193 provider's `request`. */
export type Eip1193Request = (args: { method: string; params?: unknown[] }) => Promise<unknown>;

/** A `SwapSigner` over an injected EVM wallet (EIP-1193): `eth_signTypedData_v4` from `address`. */
export function eip1193SwapSigner(provider: { request: Eip1193Request }, address: string): SwapSigner {
  return {
    address,
    async signTypedData(typedData) {
      const sig = await provider.request({
        method: 'eth_signTypedData_v4',
        params: [address, JSON.stringify(typedData)],
      });
      if (typeof sig !== 'string') throw new TempWalletError('the wallet returned no signature');
      return sig;
    },
  };
}

export interface SwapSeed {
  /** SECRET: 64 hex. Hand it to `createTempWallet` and drop it. */
  seed: string;
  /** Both "start swap" signatures were identical: the swap can be recovered by signing again (Q4). */
  deterministic: boolean;
  /** The EVM account that signed. */
  signer: string;
}

/**
 * The swap's seed from the user's "start swap" signature, asked for TWICE (spec Q4; the derivation
 * spec is core's swap-key.ts). The message binds the profile's Midnight network and vault and this
 * swap's `salt` (32 bytes of hex, kept in the browser's swap record only: the sponsor and URLs see
 * `publicSwapId(salt)`). New swaps use derivation 2, whose prompt carries the warning (P4.2-fix
 * C14); pass `derivation: 1` only to re-derive a swap started before it. Signatures from another
 * account than `signer.address` are refused. The seed of the FIRST signature is returned.
 */
export async function deriveSwapSeed(
  signer: SwapSigner,
  salt: string,
  options: {
    profile?: Pick<NetworkProfile, 'midnightNetworkId' | 'bridge' | 'evm'>;
    derivation?: SwapKeyDerivation;
  } = {},
): Promise<SwapSeed> {
  const profile = options.profile ?? STAGENET;
  if (profile.bridge.vaultAddress === '') throw new TempWalletError('the network profile names no vault');
  const out = await deriveSwapSeedCore(
    (td) => signer.signTypedData(td),
    {
      network: profile.midnightNetworkId,
      vault: profile.bridge.vaultAddress,
      salt,
      chainId: profile.evm.chainId,
      derivation: options.derivation ?? SWAP_KEY_DERIVATION_LATEST,
    },
    signer.address,
  );
  return { seed: out.seedHex, deterministic: out.deterministic, signer: out.signer };
}

// ── The wallet ───────────────────────────────────────────────────────────────

export interface WalletCoin {
  /** 64 lowercase hex. */
  colour: string;
  value: bigint;
  /** The coin's nonce (public on chain once spent; identifies the coin), 64 lowercase hex. */
  nonce: string;
}

export interface TempWallet {
  readonly profile: NetworkProfile;
  /** 64 hex: owns the wallet's shielded coins; the vault's deposit recipient. */
  readonly coinPk: string;
  /** 64 hex: coins sent to the wallet are sealed to it (the sponsor's mint mapping). */
  readonly encPk: string;
  /** `mn_shield-addr_<network>1…`, built from the two public keys (never parsed by the SDK). */
  readonly shieldedAddress: string;
  /** `mn_addr_<network>1…`: names the submitter in the batcher's envelope. */
  readonly unshieldedAddress: string;
  /** The swap's Sepolia deposit address (core `swapDepositAddress`); null without a vault. */
  readonly depositAddress: string | null;
  /** Wait until the shielded wallet has strictly caught up with the chain. */
  sync(onProgress?: (p: SyncProgressReport) => void): Promise<{ ms: number }>;
  /** Spendable balances by colour (64 lowercase hex), in base units. */
  balances(): Promise<Record<string, bigint>>;
  /** The spendable coins (public descriptions). */
  coins(): Promise<WalletCoin[]>;
  /** Subscribe to sync progress (public numbers only). Returns the unsubscribe. */
  onProgress(cb: (p: SyncProgressReport) => void): () => void;
  readonly closed: boolean;
  /** Stop syncing and wipe the keys. The object is unusable afterwards. */
  close(): Promise<void>;
}

/** What the builders need and the app never sees. */
export interface WalletInternals {
  keys: TemporaryWalletKeys;
  opened: OpenedShieldedWallet;
}

const INTERNALS = new WeakMap<TempWallet, WalletInternals>();

/** The keys and the SDK wallet behind a `TempWallet` (for this package's builders only). */
export function internalsOf(wallet: TempWallet): WalletInternals {
  const i = INTERNALS.get(wallet);
  if (i === undefined || wallet.closed) throw new TempWalletError('the temporary wallet is closed');
  return i;
}

export interface CreateTempWalletOptions {
  /** The network (default: stagenet). */
  profile?: NetworkProfile;
  /** Opens the shielded wallet (default: the SDK's ShieldedWallet over the profile's indexer). Tests
   *  pass a wallet restored from a fixture state instead. */
  openWallet?: (keys: TemporaryWalletKeys, endpoints: ShieldedEndpoints) => Promise<OpenedShieldedWallet>;
}

const norm = (h: unknown) => String(h).replace(/^0x/, '').toLowerCase();

/**
 * The temporary wallet for `seed` (64 hex, from `deriveSwapSeed`). It starts syncing the shielded
 * side at once; `sync()` waits for it. Only the shielded sub-wallet runs: the wallet never holds
 * NIGHT or DUST (the batcher pays the take, the sponsor pays the bridge legs).
 */
export async function createTempWallet(seed: string, options: CreateTempWalletOptions = {}): Promise<TempWallet> {
  const profile = options.profile ?? STAGENET;
  const keys = temporaryWalletKeys(seed, profile.midnightNetworkId);
  const endpoints: ShieldedEndpoints = {
    networkId: profile.midnightNetworkId,
    indexerUrl: profile.midnight.indexerUrl,
    indexerWsUrl: profile.midnight.indexerWsUrl,
  };
  let opened: OpenedShieldedWallet;
  try {
    opened = await (options.openWallet ?? ((k, e) => openShieldedWallet(k.shieldedSecretKeys, e)))(keys, endpoints);
  } catch (e) {
    keys.clear();
    throw e;
  }
  const depositAddress =
    profile.bridge.vaultAddress !== '' && profile.bridge.mpcRootPublicKey !== ''
      ? swapDepositAddress(profile, keys.coinPublicKey)
      : null;
  let closed = false;
  const wallet: TempWallet = {
    profile,
    coinPk: keys.coinPublicKey,
    encPk: keys.encryptionPublicKey,
    shieldedAddress: keys.shieldedAddress,
    unshieldedAddress: keys.unshieldedAddress,
    depositAddress,
    get closed() {
      return closed;
    },
    async sync(onProgress) {
      const { opened: o } = internalsOf(wallet);
      const t0 = Date.now();
      const unsub = onProgress ? o.onProgress(onProgress) : undefined;
      try {
        await Rx.firstValueFrom(
          (o.wallet.state as unknown as Rx.Observable<{ progress: { isStrictlyComplete(): boolean } }>).pipe(
            Rx.filter((s) => s.progress.isStrictlyComplete()),
          ),
        );
      } finally {
        unsub?.();
      }
      return { ms: Date.now() - t0 };
    },
    balances: async () => internalsOf(wallet).opened.balances(),
    async coins() {
      const { opened: o } = internalsOf(wallet);
      const s = (await Rx.firstValueFrom(o.wallet.state)) as unknown as {
        availableCoins: readonly { coin: { type: unknown; value: bigint; nonce: unknown } }[];
      };
      return s.availableCoins.map((c) => ({
        colour: norm(c.coin.type),
        value: c.coin.value,
        nonce: norm(c.coin.nonce),
      }));
    },
    onProgress: (cb) => internalsOf(wallet).opened.onProgress(cb),
    async close() {
      if (closed) return;
      closed = true;
      const i = INTERNALS.get(wallet);
      INTERNALS.delete(wallet);
      try {
        await i?.opened.stop();
      } finally {
        i?.keys.clear();
      }
    },
  };
  INTERNALS.set(wallet, { keys, opened });
  return wallet;
}

// Which implementation of each port the page runs (./ports.ts):
//
//   config.json with a `mock` block  →  MOCK MODE: the exchange, the sponsor and the wallet module
//                                       all run in the page on one mock chain (./mock), loaded as a
//                                       separate chunk. The sponsor client and the kernel client are
//                                       the real ones, given the mocks' `fetch`.
//   no `mock` block                  →  LIVE: core's KernelClient on the configured exchange, the real
//                                       sponsor client on `sponsorUrl`, and the real wallet module
//                                       (`@evm-midnight-transparent/wallet`) through the typed adapter
//                                       (./live-wallet.ts), with the network profile bound.
//
// The live wallet module is loaded LAZILY (its ledger and runtime WASM are about 11 MB): the offers
// list never waits for it. Loading starts in the background as soon as the backends exist, and every
// asynchronous call of the port waits for it; `ensureBufferGlobal()` runs once, right after the load
// and before the wallet builds anything (G-TAKE T.5: the SDK's address classes use Node's Buffer).
// The port's synchronous calls come after an asynchronous one of the same swap (`finalizeTake` after
// `buildTake`, `finalizeWithdraw` after `buildWithdraw`), so the module is loaded by then;
// `depositAddressFor` needs only core.

import {
  KernelClient,
  type NetworkProfile,
  type TokenRegistry,
  swapDepositAddress,
} from '@evm-midnight-transparent/core';
import type * as WalletTypes from '@evm-midnight-transparent/wallet';

import type { SiteConfig } from '../config.js';
import { adaptWalletModule } from './live-wallet.js';
import type { SwapBackends, WalletModule } from './ports.js';
import { HttpSponsorApi } from './sponsor-client.js';
import type { EvmReader } from './mock/index.js';

type WalletPackage = typeof WalletTypes;

export class WalletModuleUnavailable extends Error {
  override name = 'WalletModuleUnavailable';
  constructor(cause?: unknown) {
    super(
      `The in-browser Midnight wallet could not be loaded${
        cause instanceof Error && cause.message ? ` (${cause.message.slice(0, 160)})` : ''
      }. Reload the page to try again.`,
    );
  }
}

/** The real wallet module, loaded on first use (or when `preload()` is called). */
export function lazyWalletModule(
  profile: NetworkProfile,
  load: () => Promise<WalletPackage> = () => import('@evm-midnight-transparent/wallet'),
): WalletModule & { preload(): Promise<void> } {
  let loaded: WalletModule | null = null;
  let loading: Promise<WalletModule> | null = null;
  const get = (): Promise<WalletModule> => {
    loading ??= load().then(
      (w) => {
        w.ensureBufferGlobal();
        loaded = adaptWalletModule(w, profile);
        return loaded;
      },
      (e: unknown) => {
        loading = null; // a later call tries again
        throw new WalletModuleUnavailable(e);
      },
    );
    return loading;
  };
  const now = (): WalletModule => {
    if (!loaded) throw new WalletModuleUnavailable();
    return loaded;
  };
  return {
    kind: 'live',
    preload: async () => {
      await get();
    },
    deriveSwapSeed: async (signer, salt) => (await get()).deriveSwapSeed(signer, salt),
    createTempWallet: async (seed) => (await get()).createTempWallet(seed),
    depositAddressFor: (coinPk) => swapDepositAddress(profile, coinPk),
    buildTake: async (wallet, offerBech32) => (await get()).buildTake(wallet, offerBech32),
    finalizeTake: (draft, provenHex) => now().finalizeTake(draft, provenHex),
    submitTake: async (wallet, settlement) => (await get()).submitTake(wallet, settlement),
    buildWithdraw: async (wallet, params) => (await get()).buildWithdraw(wallet, params),
    finalizeWithdraw: (draft, provenHex) => now().finalizeWithdraw(draft, provenHex),
  };
}

export interface WiredBackends extends SwapBackends {
  /** Mock mode only: hand the connected wallet's Sepolia reads to the mock sponsor. */
  setEvmReader(reader: EvmReader | null): void;
  stop(): void;
}

export async function createBackends(config: SiteConfig, registry: TokenRegistry): Promise<WiredBackends> {
  const { network } = config;
  if (config.mock) {
    const { createMockEnvironment } = await import('./mock/index.js');
    const env = createMockEnvironment({ network, registry, settings: config.mock });
    return {
      kernel: new KernelClient({
        baseUrl: network.zswap.kernelUrl,
        fetch: env.kernelFetch,
        retries: 0,
        timeoutMs: 5_000,
      }),
      sponsor: new HttpSponsorApi(config.sponsorUrl || 'https://sponsor.mock.invalid', { fetch: env.sponsorFetch }),
      wallet: env.wallet,
      mock: {
        describe: `The exchange, the sponsor and the Midnight wallet are simulated in this page, with no real funds. Only a mock or test EVM wallet${env.builtInEvm ? ' (connect "Mock wallet (no real funds)")' : ''} can send the swap's Sepolia transactions here.`,
      },
      pollMs: Math.max(50, Math.floor(config.mock.stepMs / 2)),
      setEvmReader: env.setEvmReader,
      stop: env.stop,
    };
  }
  const wallet = lazyWalletModule(network);
  // Warm it up while the user reads the offers (only where a swap can start); a failure here is
  // retried by the first real call.
  if (config.sponsorUrl) void wallet.preload().catch(() => undefined);
  return {
    kernel: new KernelClient({ baseUrl: network.zswap.kernelUrl }),
    sponsor: config.sponsorUrl ? new HttpSponsorApi(config.sponsorUrl) : null,
    wallet,
    mock: null,
    pollMs: 5_000,
    setEvmReader: () => {},
    stop: () => {},
  };
}

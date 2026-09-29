// Which implementation of each port the page runs (./ports.ts):
//
//   config.json with a `mock` block  →  MOCK MODE: the exchange, the sponsor and the wallet module
//                                       all run in the page on one mock chain (./mock), loaded as a
//                                       separate chunk. The sponsor client and the kernel client are
//                                       the real ones, given the mocks' `fetch`.
//   no `mock` block                  →  LIVE: core's KernelClient on the configured exchange, the real
//                                       sponsor client on `sponsorUrl`, and the wallet module below.
//
// P3 (integration) replaces `liveWalletModule()` below with the real module through the typed adapter
// (./live-wallet.ts, checked against `@evm-midnight-transparent/wallet` by the compiler and by
// web/test/live-wallet.test.ts):
//
//   const w = await import('@evm-midnight-transparent/wallet');   // its WASM loads only then
//   w.ensureBufferGlobal();
//   wallet: adaptWalletModule(w, network)
//
// and removes the `mock` block from the deployed config.json. Until then a live build lists the real
// offers but cannot start a swap.

import { KernelClient, type TokenRegistry } from '@evm-midnight-transparent/core';

import type { SiteConfig } from '../config.js';
import type { SwapBackends, WalletModule } from './ports.js';
import { HttpSponsorApi } from './sponsor-client.js';
import type { EvmReader } from './mock/index.js';

export class WalletModuleUnavailable extends Error {
  override name = 'WalletModuleUnavailable';
  constructor() {
    super('The in-browser Midnight wallet is not part of this build yet, so a swap cannot start here.');
  }
}

/** The live wallet module until P3 wires `adaptWalletModule` (see the header). */
export function liveWalletModule(): WalletModule {
  const no = async (): Promise<never> => {
    throw new WalletModuleUnavailable();
  };
  return {
    kind: 'unavailable',
    deriveSwapSeed: no,
    createTempWallet: no,
    depositAddressFor: () => {
      throw new WalletModuleUnavailable();
    },
    buildTake: no,
    finalizeTake: () => {
      throw new WalletModuleUnavailable();
    },
    submitTake: no,
    buildWithdraw: no,
    finalizeWithdraw: () => {
      throw new WalletModuleUnavailable();
    },
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
  return {
    kernel: new KernelClient({ baseUrl: network.zswap.kernelUrl }),
    sponsor: config.sponsorUrl ? new HttpSponsorApi(config.sponsorUrl) : null,
    wallet: liveWalletModule(),
    mock: null,
    pollMs: 5_000,
    setEvmReader: () => {},
    stop: () => {},
  };
}

// Mock mode: the three ports (exchange, sponsor, wallet module) on one mock chain, in the page. Loaded
// only when `config.json` has a `mock` block (a separate chunk; the live build never runs it).
//
// The specs steer it through `window.__emtMock` (see `MockControls`): consume an offer (someone else
// took it), change the scenario, the step time, or take the exchange down.

import type { NetworkProfile, TokenRegistry } from '@evm-midnight-transparent/core';

import type { WalletModule } from '../ports.js';
import { MockChain, type MockChainDump } from './chain.js';
import { announceMockEvmWallet } from './evm-wallet.js';
import { mockKernelFetch } from './kernel.js';
import { type EvmReader, MockSponsor, type MockScenario, type MockSponsorDump } from './sponsor.js';
import { type MockWalletStats, mockWalletModule } from './wallet.js';

export type { EvmReader, MockScenario };

export interface MockSettings {
  /** Time between two sponsor stages, ms (default 1,500). */
  stepMs: number;
  scenario: MockScenario;
  /** Announce the built-in mock EVM wallet (no extension needed). */
  evmWallet: boolean;
  book: 'default' | 'empty';
  /** Keep the mock world (book, coins, the sponsor's swaps) in this browser's localStorage under
   *  `emt-mock/world`, so a reload or a new tab finds it again, as a real backend would. */
  persist: boolean;
}

export const MOCK_WORLD_KEY = 'emt-mock/world';

interface World {
  v: 1;
  chain: MockChainDump;
  sponsor: MockSponsorDump;
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export interface MockControls {
  consumeOffer(offerId: string): void;
  liveOfferIds(): string[];
  setScenario(patch: Partial<MockScenario>): void;
  /** Fail every swap still waiting for its funds (`funds-not-received`), recoverable or not (C5). */
  failAwaitingFunds(recoverable: boolean): void;
  /** Fail every swap waiting for or running its deposit as a failed sweep (`deposit-attempts`: the
   *  tokens stay at the deposit address), recoverable or not (P4.2-fix2 R7). */
  failDeposit(recoverable: boolean): void;
  /** Double the sweep gas of every swap still waiting for its funds (the base fee rose). */
  raiseSweepGas(): void;
  /** Another party's request swept `units` base units of the pay token off every deposit address
   *  and won the sweep race; the sponsor completed it: a PARTIAL deposit (P4.2-fix3 S2). The spec
   *  moves the units (and the ETH the sweep used) off the address in its fake Sepolia. */
  partialSweep(units: number | string): void;
  setStepMs(ms: number): void;
  /** Answer every exchange request with this HTTP status (null: back up). */
  setKernelDown(status: number | null): void;
  /** Forget the persisted mock world (the next load starts a fresh one). */
  resetWorld(): void;
  views(): unknown[];
  requests(): Array<{ method: string; path: string }>;
  /** How many drafts the wallet module built and released. */
  walletStats(): MockWalletStats;
  /** The receipt of a transfer the mock bridge mined on its fake Sepolia, as `eth_getTransactionReceipt`
   *  answers it, or null: the mock and test EVM wallets answer the page's receipt reads with it
   *  (P4.2-fix4). */
  sepoliaReceipt(hash: string): Record<string, unknown> | null;
  /** The transaction of such a transfer, as `eth_getTransactionByHash` answers it (P4.2-fix5 U4). */
  sepoliaTransaction(hash: string): Record<string, unknown> | null;
}

export interface MockEnvironment {
  chain: MockChain;
  sponsor: MockSponsor;
  /** The mock sponsor's fetch, persisting the world after every request. */
  sponsorFetch: MockSponsor['fetch'];
  kernelFetch: ReturnType<typeof mockKernelFetch>;
  wallet: WalletModule;
  controls: MockControls;
  /** The connected wallet's Sepolia reads, for the mock sponsor's deposit watch. */
  setEvmReader(reader: EvmReader | null): void;
  /** True when the built-in mock EVM wallet was announced. */
  builtInEvm: boolean;
  stop(): void;
}

export function createMockEnvironment(input: {
  network: NetworkProfile;
  registry: TokenRegistry;
  settings: MockSettings;
}): MockEnvironment {
  const { network, registry } = input;
  const settings = { ...input.settings, scenario: { ...input.settings.scenario } };
  const chain = new MockChain(registry);
  let kernelDown: number | null = null;
  const wallet = mockWalletModule(chain, {
    profile: network,
    syncMs: () => Math.min(settings.stepMs, 1_000),
  });
  const sponsor = new MockSponsor({
    chain,
    registry,
    network: network.name,
    chainId: network.evm.chainId,
    depositAddressFor: wallet.depositAddressFor,
    scenario: settings.scenario,
    vaultEvmAddress: network.bridge.vaultEvmAddress,
  });
  const storage = settings.persist ? browserStorage() : null;
  const saved = ((): World | null => {
    try {
      const raw = storage?.getItem(MOCK_WORLD_KEY);
      const w = raw ? (JSON.parse(raw) as World) : null;
      return w && w.v === 1 ? w : null;
    } catch {
      return null;
    }
  })();
  if (saved) {
    chain.restore(saved.chain);
    sponsor.restore(saved.sponsor);
  } else if (settings.book === 'default') chain.seedDefaultBook();
  const persist = () => {
    try {
      storage?.setItem(
        MOCK_WORLD_KEY,
        JSON.stringify({ v: 1, chain: chain.dump(), sponsor: sponsor.dump() } satisfies World),
      );
    } catch {
      /* no room: the world lives in memory only */
    }
  };
  persist();
  chain.subscribe(persist);

  let timer: ReturnType<typeof setInterval> | undefined;
  const clock = () => {
    clearInterval(timer);
    timer = setInterval(() => void sponsor.tick().then(persist), settings.stepMs);
  };
  clock();

  // The mock sponsor reads the deposit address through whichever wallet is connected (the built-in
  // one answers balance reads for any address, as the specs' test wallet does).
  const builtIn = settings.evmWallet
    ? announceMockEvmWallet(
        registry,
        window,
        (h) => chain.sepoliaReceipt(h),
        (h) => chain.sepoliaTransaction(h),
      )
    : null;

  const controls: MockControls = {
    consumeOffer: (id) => chain.consume(id),
    liveOfferIds: () => chain.liveOffers().map((o) => o.offerId),
    setScenario: (patch) => Object.assign(settings.scenario, patch),
    failAwaitingFunds: (recoverable) => {
      sponsor.failAwaitingFunds(recoverable);
      persist();
    },
    failDeposit: (recoverable) => {
      sponsor.failDeposit(recoverable);
      persist();
    },
    raiseSweepGas: () => {
      sponsor.raiseSweepGas();
      persist();
    },
    partialSweep: (units) => {
      sponsor.partialSweep(BigInt(units));
      persist();
    },
    setStepMs: (ms) => {
      settings.stepMs = ms;
      clock();
    },
    setKernelDown: (status) => {
      kernelDown = status;
    },
    resetWorld: () => storage?.removeItem(MOCK_WORLD_KEY),
    views: () => sponsor.views(),
    requests: () => [...sponsor.requests],
    walletStats: () => ({ ...wallet.stats }),
    sepoliaReceipt: (hash) => chain.sepoliaReceipt(hash),
    sepoliaTransaction: (hash) => chain.sepoliaTransaction(hash),
  };
  (globalThis as { __emtMock?: MockControls }).__emtMock = controls;

  return {
    chain,
    sponsor,
    sponsorFetch: async (url, init) => {
      const res = await sponsor.fetch(url, init);
      persist();
      return res;
    },
    kernelFetch: mockKernelFetch(chain, { down: () => kernelDown }),
    wallet,
    controls,
    builtInEvm: builtIn !== null,
    setEvmReader: (reader) => sponsor.setEvmReader(reader),
    stop: () => clearInterval(timer),
  };
}

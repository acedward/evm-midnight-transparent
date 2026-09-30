// The swap section's state for the whole app: the token registry, the ports (mock or live,
// ./wiring.ts), the live offer feed (core's OfferFeed: the whole book, refreshed on the kernel's
// offer stream), the running swap sessions of this tab, and the connected wallet's swap records.
//
// Sessions live here, not in a page, so a swap keeps running while the user looks at another tab of
// the app. They are closed (their secrets forgotten) when the wallet disconnects or changes account,
// and their funding is paused while the wallet is on another network (P4.2-fix C9).

import {
  type FeedState,
  OfferFeed,
  type SwapOffer,
  type TokenRegistry,
  registryFor,
} from '@evm-midnight-transparent/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import type { SiteConfig } from '../config.js';
import { useStore } from '../store/StoreContext.js';
import { useWallet } from '../wallet/WalletContext.js';
import { type EvmPort, evmPort, walletSigner } from './evm.js';
import type { SwapRecord } from './record-shape.js';
import { readSwapRecords, saveSwapRecord } from './records.js';
import { type SessionDeps, SwapSession } from './session.js';
import { type WiredBackends, createBackends } from './wiring.js';

/** In mock mode, only these wallets may send "funds" (their Sepolia is fake): never a real one. */
export const MOCK_FUNDING_WALLETS = ['mock.evm-midnight-swap', 'test.evm-midnight-swap'];

export interface SwapState {
  config: SiteConfig;
  registry: TokenRegistry | null;
  backends: WiredBackends | null;
  /** Why the swap section cannot run at all (a bad token list, a failed mock load). */
  failure: string | null;
  feed: FeedState;
  /** Why a swap cannot start right now, or null. */
  startBlocker: string | null;
  records: SwapRecord[];
  /** The connected wallet's Sepolia port (reads and transactions), or null. */
  evm: EvmPort | null;
  session(swapId: string): SwapSession | undefined;
  begin(offer: SwapOffer): string | null;
  resume(record: SwapRecord): void;
  refreshFeed(): void;
}

const Ctx = createContext<SwapState | null>(null);
const LOADING: FeedState = { status: 'loading', stream: 'off' };

export function SwapProvider({ config, children }: { config: SiteConfig; children: ReactNode }) {
  const { network } = config;
  const wallet = useWallet();
  const { store, revision, status: storeStatus } = useStore();
  const [backendFailure, setBackendFailure] = useState<string | null>(null);
  const { registry, registryError } = useMemo(() => {
    try {
      return { registry: registryFor(network.name, config.tokens), registryError: null };
    } catch (e) {
      return { registry: null, registryError: e instanceof Error ? e.message : 'the token list could not be read' };
    }
  }, [network.name, config.tokens]);
  const failure = registryError ?? backendFailure;

  const [backends, setBackends] = useState<WiredBackends | null>(null);
  useEffect(() => {
    if (!registry) return;
    let live = true;
    let made: WiredBackends | null = null;
    createBackends(config, registry).then(
      (b) => {
        made = b;
        if (live) setBackends(b);
        else b.stop();
      },
      (e: unknown) => {
        if (live) setBackendFailure(e instanceof Error ? e.message : 'the swap services could not start');
      },
    );
    return () => {
      live = false;
      made?.stop();
    };
  }, [config, registry]);

  // The live book.
  const feed = useMemo(
    () => (backends && registry ? new OfferFeed({ client: backends.kernel, registry }) : null),
    [backends, registry],
  );
  useEffect(() => {
    if (!feed) return;
    feed.start();
    return () => feed.stop();
  }, [feed]);
  const feedState = useSyncExternalStore(
    useCallback((cb: () => void) => (feed ? feed.subscribe(cb) : () => {}), [feed]),
    () => feed?.getState() ?? LOADING,
  );

  // The connected wallet, as the ports need it.
  const connected = wallet.status === 'connected' && wallet.provider && wallet.address ? wallet : null;
  const evm = useMemo(
    () =>
      connected
        ? evmPort(connected.provider!, connected.address!, {
            chainIdHex: network.evm.chainIdHex,
            chainName: network.evm.chainName,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connected?.provider, connected?.address, network.evm.chainIdHex, network.evm.chainName],
  );
  useEffect(() => {
    backends?.setEvmReader(evm);
  }, [backends, evm]);

  // Sessions: closed when the account changes or disconnects.
  const sessions = useRef(new Map<string, SwapSession>());
  const [, bump] = useState(0);
  useEffect(() => {
    const map = sessions.current;
    return () => {
      for (const s of map.values()) void s.close();
      map.clear();
    };
  }, [connected?.address]);

  // The wallet left Sepolia (chainChanged): pause every session's funding until it is back (C9). An
  // account change closes the sessions (above); each send also asks the wallet itself first.
  const offChain = !!connected && !connected.onRightChain;
  useEffect(() => {
    const reason = offChain
      ? `Your wallet switched away from ${network.evm.chainName}: funding is paused. Switch it back to ${network.evm.chainName} to send the funds.`
      : null;
    for (const s of sessions.current.values()) if (!s.isClosed) s.setFundingBlocked(reason);
  }, [offChain, network.evm.chainName]);

  // Leaving the page while a swap runs: the browser asks first.
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      const running = [...sessions.current.values()].some((s) => {
        const k = s.getSnapshot().status.kind;
        return !s.isClosed && k !== 'done' && k !== 'stopped' && k !== 'error';
      });
      if (running) e.preventDefault();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, []);

  const records = useMemo(
    () => (store && connected ? readSwapRecords(store, { network: network.name, evmAddress: connected.address! }) : []),
    // `revision` changes on every write here or in another tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, revision, connected?.address, network.name],
  );

  const startBlocker = (() => {
    if (failure) return failure;
    if (!backends) return 'Starting…';
    if (!backends.sponsor) return 'No sponsor service is configured for this site, so a swap cannot start.';
    if (backends.wallet.kind === 'unavailable')
      return 'The in-browser Midnight wallet is not part of this build yet, so a swap cannot start.';
    if (!connected) return 'Connect your wallet to swap.';
    if (!connected.onRightChain) return `Switch your wallet to ${network.evm.chainName} to swap.`;
    if (storeStatus !== 'ok' || !store || store.readOnly)
      return 'This browser is not keeping records for this site, and a swap needs its record to be resumed.';
    return null;
  })();

  const deps = useCallback((): SessionDeps | null => {
    if (!backends || !registry || !connected || !evm || !store) return null;
    return {
      backends,
      network,
      registry,
      signer: walletSigner(connected.provider!, connected.address!),
      evm,
      save: (r) => saveSwapRecord(store, r),
      fundingRefusal: () =>
        backends.mock && !MOCK_FUNDING_WALLETS.includes(connected.walletRdns ?? '')
          ? 'Mock mode never sends real funds: connect the "Mock wallet (no real funds)" to try the swap here.'
          : null,
    };
  }, [backends, registry, connected, evm, store, network]);

  const value: SwapState = {
    config,
    registry,
    backends,
    failure,
    feed: feedState,
    startBlocker,
    records,
    evm,
    session: (id) => sessions.current.get(id.toLowerCase()),
    begin: (offer) => {
      const d = deps();
      if (!d || startBlocker) return null;
      const s = SwapSession.begin(offer, d);
      const id = s.getSnapshot().swapId;
      sessions.current.set(id, s);
      bump((n) => n + 1);
      return id;
    },
    resume: (record) => {
      const d = deps();
      if (!d) return;
      const old = sessions.current.get(record.swapId);
      // A session stopped for good (a failed swap the sponsor can revive, C5) makes way for the resume.
      if (old && !old.isClosed) {
        if (!old.isStuck) return;
        void old.close();
      }
      sessions.current.set(record.swapId, SwapSession.resume(record, d));
      bump((n) => n + 1);
    },
    refreshFeed: () => void feed?.refresh(),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSwap(): SwapState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSwap outside SwapProvider');
  return v;
}

/** A session's live snapshot (re-renders on every change). */
export function useSession(session: SwapSession | undefined) {
  return useSyncExternalStore(
    useCallback((cb: () => void) => (session ? session.subscribe(cb) : () => {}), [session]),
    () => session?.getSnapshot() ?? null,
  );
}

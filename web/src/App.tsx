// The application shell: the masthead (the app's name, the connected wallet with its Sepolia badge,
// and the Midnight network), the tab bar, the sections and the testnet footer. The pieces come from
// ./design; this file only wires them to the wallet and the store. Adapted from MN Bank
// (acedward/passport-evm-dapp @ 911647b, web/src/App.tsx).
//
// TODO(L-WEB): the Swap section (the live offers both of whose tokens the vault bridges, the swap
// page and its stages, "Swap is not available" with Bridge back, and resume).

import { useEffect, useState } from 'react';

import type { NetworkProfile } from '@evm-midnight-transparent/core';

import { APP_NAME } from './brand.js';
import { loadSiteConfig, type SiteConfig } from './config.js';
import {
  Button,
  EmptyState,
  IdentityChip,
  Masthead,
  NetworkBadge,
  Notice,
  PageHead,
  SiteFooter,
  TabNav,
  shortHex,
} from './design/index.js';
import { LocalData } from './pages/LocalData.js';
import { storageText } from './store/messages.js';
import { StoreProvider, useStore } from './store/StoreContext.js';
import { WalletProvider, useWallet } from './wallet/WalletContext.js';

export const SECTIONS = [
  { id: 'swap', label: 'Swap' },
  { id: 'local', label: 'Local data' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const sectionFromHash = (): SectionId => {
  // A section may carry parameters after '?' (#swap?offer=…).
  const h = window.location.hash.replace(/^#/, '').split('?')[0] ?? '';
  return (SECTIONS.find((s) => s.id === h)?.id ?? 'swap') as SectionId;
};

/** The right-hand side of the masthead: who is connected, on which networks. */
function Identity({ network }: { network: NetworkProfile }) {
  const w = useWallet();
  const [choosing, setChoosing] = useState(false);
  const midnight = (
    <NetworkBadge network="midnight" data-testid="network-name">
      Midnight {network.name}
    </NetworkBadge>
  );

  if (w.status === 'connected' && w.address) {
    return (
      <>
        <IdentityChip
          label="Wallet"
          data-testid="wallet-connected"
          value={
            <span className="id-value" data-testid="wallet-address" title={w.address}>
              {shortHex(w.address)}
            </span>
          }
          badge={
            w.onRightChain ? (
              <NetworkBadge network="sepolia" data-testid="wallet-chain">
                {network.evm.chainName}
              </NetworkBadge>
            ) : (
              <Button
                variant="inverse"
                size="small"
                data-testid="switch-network"
                onClick={() => void w.switchNetwork()}
              >
                Switch to {network.evm.chainName}
              </Button>
            )
          }
        >
          <Button variant="link" onClick={w.disconnect}>
            Disconnect
          </Button>
        </IdentityChip>
        <IdentityChip label="Network" badge={midnight} />
      </>
    );
  }
  return (
    <>
      <IdentityChip label="Network" badge={midnight} />
      <div className="wallet-area">
        <Button
          variant="inverse"
          data-testid="connect"
          aria-expanded={choosing}
          aria-haspopup="menu"
          disabled={w.status === 'connecting'}
          onClick={() => setChoosing((c) => !c)}
        >
          {w.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
        </Button>
        {choosing && (
          <div className="wallet-menu" role="menu" aria-label="Choose a wallet" data-testid="wallet-menu">
            {w.options.length === 0 ? (
              <p className="small">
                No wallet found in this browser. Install MetaMask or another EVM wallet, then reload.
              </p>
            ) : (
              <>
                <p className="wallet-menu-title">Choose a wallet</p>
                {w.options.map((o) => (
                  <Button
                    variant="secondary"
                    role="menuitem"
                    key={o.id}
                    data-testid="wallet-option"
                    onClick={() => {
                      setChoosing(false);
                      void w.connect(o);
                    }}
                  >
                    {o.icon && <img src={o.icon} alt="" width={20} height={20} />} {o.name}
                  </Button>
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Remember that this wallet has used the app on this network (its first record here). */
function ProfileRecorder({ network }: { network: string }) {
  const { store } = useStore();
  const { address, status } = useWallet();
  useEffect(() => {
    if (!store || store.readOnly || status !== 'connected' || !address) return;
    const scope = { network, evmAddress: address };
    const existing = store.list(scope).find((r) => r.parsed.kind === 'profile' && !r.parsed.scope.global);
    const firstSeen = (existing?.record?.data as { firstSeen?: number } | undefined)?.firstSeen ?? Date.now();
    store.put(scope, 'profile', { firstSeen, lastSeen: Date.now() });
  }, [store, address, status, network]);
  return null;
}

function Shell({ network }: { network: NetworkProfile }) {
  const [section, setSection] = useState<SectionId>(sectionFromHash);
  useEffect(() => {
    const on = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const { status } = useStore();
  const wallet = useWallet();
  const wrongNetwork = wallet.status === 'connected' && !wallet.onRightChain;
  const storage = status === 'ok' ? null : storageText(status);
  return (
    <div className="app">
      <Masthead>
        <Identity network={network} />
      </Masthead>
      <TabNav items={SECTIONS} current={section} />
      <div className="wrap app-banner app-banner-stack">
        {storage && (
          <Notice tone="danger" role="alert" title={storage.title} data-testid="storage-banner" data-status={status}>
            {storage.text}
          </Notice>
        )}
        {wrongNetwork && (
          <Notice tone="warning" role="alert" title="Your wallet is on another network." data-testid="wrong-network">
            {APP_NAME} works on {network.evm.chainName}
            {wallet.chainId ? ` (your wallet is on chain ${parseInt(wallet.chainId, 16) || wallet.chainId})` : ''}.
            Nothing will be signed or sent until you switch.{' '}
            <Button
              variant="secondary"
              size="small"
              data-testid="wrong-network-switch"
              onClick={() => void wallet.switchNetwork()}
            >
              Switch to {network.evm.chainName}
            </Button>
          </Notice>
        )}
        {wallet.error && (
          <Notice tone="danger" role="alert" data-testid="wallet-error">
            {wallet.error}
          </Notice>
        )}
      </div>
      <main className="wrap">
        {section === 'local' ? (
          <LocalData network={network.name} />
        ) : (
          <section data-testid="section-swap">
            <PageHead title="Swap" />
            <EmptyState title="Coming soon">
              The offers you can take from your EVM wallet will be listed here. Your records are under{' '}
              <a href="#local">Local data</a>.
            </EmptyState>
          </section>
        )}
      </main>
      <SiteFooter networkName={`Midnight ${network.name}`} evmName={`Ethereum ${network.evm.chainName}`} />
      <ProfileRecorder network={network.name} />
    </div>
  );
}

export function App() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    loadSiteConfig().then(setConfig, (e: unknown) => setFailed(e instanceof Error ? e.message : 'configuration error'));
  }, []);
  if (failed)
    return (
      <div className="wrap app-banner">
        <Notice tone="danger" role="alert">
          {APP_NAME} could not start: {failed}
        </Notice>
      </div>
    );
  if (!config)
    return (
      <p className="wrap app-banner muted" role="status">
        Loading…
      </p>
    );
  return (
    <StoreProvider>
      <WalletProvider network={config.network}>
        <Shell network={config.network} />
      </WalletProvider>
    </StoreProvider>
  );
}

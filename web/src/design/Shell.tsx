// The frame every page sits in: the navy masthead (the monogram, the app's name and tagline from
// ../brand.ts, and the user's identity on the right), the white tab bar, and the testnet footer.
// Copied from MN Bank's design system (acedward/passport-evm-dapp @ 911647b, web/src/design).
//
//   <Masthead>
//     <IdentityChip label="Wallet" value={<span title={addr}>0x4847…e56b</span>} badge={<NetworkBadge network="sepolia" />} />
//     <IdentityChip label="Network" badge={<NetworkBadge network="midnight">Midnight stagenet</NetworkBadge>} />
//   </Masthead>
//   <TabNav items={[{ id: 'accounts', label: 'Accounts' }, …]} current="accounts" />
//   <SiteFooter />

import type { HTMLAttributes, ReactNode } from 'react';

import { APP_MONOGRAM, APP_NAME, APP_TAGLINE } from '../brand.js';
import { cx } from './format.js';

export function Masthead({ homeHref = '#swap', children }: { homeHref?: string; children?: ReactNode }) {
  return (
    <header className="masthead">
      <div className="wrap masthead-inner">
        <h1 className="brand">
          <a href={homeHref}>
            <span className="monogram" aria-hidden="true">
              {APP_MONOGRAM}
            </span>
            <span>
              <span className="brand-name">{APP_NAME}</span> <span className="brand-tagline">{APP_TAGLINE}</span>
            </span>
          </a>
        </h1>
        {children ? <div className="identity">{children}</div> : null}
      </div>
    </header>
  );
}

export function IdentityChip({
  label,
  value,
  badge,
  className,
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, 'title'> & { label: ReactNode; value?: ReactNode; badge?: ReactNode }) {
  return (
    <div className={cx('id-chip', className)} {...rest}>
      <span className="id-label">{label}</span>
      {value}
      {badge}
      {children}
    </div>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
}

export function TabNav({
  items,
  current,
  label = 'Sections',
}: {
  items: ReadonlyArray<TabItem>;
  current: string;
  label?: string;
}) {
  return (
    <nav className="tabs" aria-label={label}>
      <div className="wrap">
        <ul>
          {items.map((t) => (
            <li key={t.id}>
              <a href={`#${t.id}`} aria-current={current === t.id ? 'page' : undefined} data-testid={`tab-${t.id}`}>
                {t.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

export function SiteFooter({ networkName = 'Midnight stagenet', evmName = 'Ethereum Sepolia' }) {
  return (
    <footer className="site-foot">
      <div className="wrap">
        <p className="testnet" data-testid="testnet-notice">
          Testnet only — {networkName} and {evmName}. Tokens have no real value.
        </p>
        <p>
          This app never asks for your wallet&apos;s seed or private key: you sign in your wallet, and each swap&apos;s
          Midnight wallet lives only in this tab.
        </p>
      </div>
    </footer>
  );
}

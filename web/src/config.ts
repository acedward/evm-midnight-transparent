// The site's runtime configuration: `config.json` next to index.html, so a deployment can point
// the same build at another network or sponsor without rebuilding. Anything missing falls back to
// the stagenet profile. Adapted from MN Bank (acedward/passport-evm-dapp @ 911647b, web/src/config.ts).

import { type NetworkOverrides, type NetworkProfile, resolveNetwork } from '@evm-midnight-transparent/core';

export interface SiteConfig {
  network: NetworkProfile;
  /** The sponsor service's base URL ('' until the app calls it). */
  sponsorUrl: string;
  /** The token list when the network has no built-in one (a local stack's colours); stagenet's
   *  comes from the vault records vendored in core. */
  tokens?: unknown;
}

export async function loadSiteConfig(fetchImpl: typeof fetch = fetch): Promise<SiteConfig> {
  let raw: { network?: unknown; sponsorUrl?: unknown; overrides?: unknown; tokens?: unknown } = {};
  try {
    const res = await fetchImpl('./config.json', { cache: 'no-store' });
    if (res.ok) raw = (await res.json()) as typeof raw;
  } catch {
    /* no config.json: defaults */
  }
  const name = typeof raw.network === 'string' ? raw.network : 'stagenet';
  const overrides = raw.overrides && typeof raw.overrides === 'object' ? (raw.overrides as NetworkOverrides) : {};
  return {
    network: resolveNetwork(name, overrides),
    sponsorUrl: typeof raw.sponsorUrl === 'string' ? raw.sponsorUrl : '',
    ...(raw.tokens !== undefined ? { tokens: raw.tokens } : {}),
  };
}

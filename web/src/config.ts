// The site's runtime configuration: `config.json` next to index.html, so a deployment can point
// the same build at another network or sponsor without rebuilding. Anything missing falls back to
// the stagenet profile. Adapted from MN Bank (acedward/passport-evm-dapp @ 911647b, web/src/config.ts).

import { type NetworkOverrides, type NetworkProfile, resolveNetwork } from '@evm-midnight-transparent/core';
import { z } from 'zod';

export interface SiteConfig {
  network: NetworkProfile;
  /** The sponsor service's base URL, absolute ('' when none is configured: swaps cannot start).
   *  config.json may give it relative to the site (`/sponsor`, the same-origin proxy of the deploy
   *  bundle): it is resolved against the page's address. */
  sponsorUrl: string;
  /** The token list when the network has no built-in one (a local stack's colours); stagenet's
   *  comes from the vault records vendored in core. */
  tokens?: unknown;
  /** Mock mode (P2, CI and the browser specs): the exchange, the sponsor and the wallet module run
   *  in the page on a mock chain, with no real funds. Absent in a real deployment. */
  mock?: MockSettings;
}

/** `config.json`'s `mock` block. `true` means all defaults. */
export const MockSettingsSchema = z
  .object({
    stepMs: z.number().int().min(10).max(60_000).default(1_500),
    scenario: z
      .object({
        offerGoneAtTake: z.boolean().optional(),
        refundFirstWithdrawal: z.boolean().optional(),
        refuseOpen: z.string().max(200).optional(),
        staleWithdrawOnce: z.boolean().optional(),
        failFirstStart: z.boolean().optional(),
        // P4.2-fix4: the first withdrawal's Sepolia transfer, and holding the bridge's closing.
        transferReceipt: z.enum(['ok', 'reverted', 'wrong-token', 'wrong-amount', 'older']).optional(),
        holdAfterTransfer: z.boolean().optional(),
      })
      .strict()
      .default({}),
    evmWallet: z.boolean().default(false),
    book: z.enum(['default', 'empty']).default('default'),
    persist: z.boolean().default(true),
  })
  .strict();
export type MockSettings = z.infer<typeof MockSettingsSchema>;

export class SiteConfigError extends Error {
  override name = 'SiteConfigError';
}

function parseMock(raw: unknown): MockSettings | undefined {
  if (raw === undefined || raw === false || raw === null) return undefined;
  const parsed = MockSettingsSchema.safeParse(raw === true ? {} : raw);
  if (!parsed.success) throw new SiteConfigError('config.json: the mock settings are not valid');
  return parsed.data;
}

/** An absolute sponsor URL: kept as is, or resolved against `base` (the page's address) when it is
 *  a path; '' when absent or unusable. */
export function resolveSponsorUrl(raw: unknown, base: string | undefined): string {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  try {
    return new URL(raw.trim(), base).href.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export async function loadSiteConfig(
  fetchImpl: typeof fetch = fetch,
  base: string | undefined = globalThis.location?.href,
): Promise<SiteConfig> {
  let raw: { network?: unknown; sponsorUrl?: unknown; overrides?: unknown; tokens?: unknown; mock?: unknown } = {};
  try {
    const res = await fetchImpl('./config.json', { cache: 'no-store' });
    if (res.ok) raw = (await res.json()) as typeof raw;
  } catch {
    /* no config.json: defaults */
  }
  const name = typeof raw.network === 'string' ? raw.network : 'stagenet';
  const overrides = raw.overrides && typeof raw.overrides === 'object' ? (raw.overrides as NetworkOverrides) : {};
  const mock = parseMock(raw.mock);
  return {
    network: resolveNetwork(name, overrides),
    sponsorUrl: resolveSponsorUrl(raw.sponsorUrl, base),
    ...(raw.tokens !== undefined ? { tokens: raw.tokens } : {}),
    ...(mock ? { mock } : {}),
  };
}

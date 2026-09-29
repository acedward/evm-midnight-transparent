// The token registry: the tokens the ERC20 vault bridges between Sepolia and Midnight stagenet.
//
// No token is special (owner rule): there are no quote or stock roles, and a pair is simply an
// offer's two legs. An offer can be swapped when both of its legs are tokens in this registry.
//
// The stagenet registry is built from the vault's own deployment records, vendored beside this
// file byte for byte (PROVENANCE.md): `stagenet-vault.json`'s `bridgedTokens` is the list, and the
// Sepolia records (`sepolia-*.json`) must agree with it on every token they describe. A local
// stack's registry is supplied as configuration (its vault and colours are new on every stack).
//
// Adapted from MN Bank (acedward/passport-evm-dapp @ 911647b, packages/core/src/tokens/registry.ts)
// with the roles removed.

import { getAddress } from 'ethers';
import { z } from 'zod';

import { normaliseHex32 } from '../hex.js';
import type { NetworkName } from '../network.js';
// Named imports, so a browser bundle carries only these fields of the vendored records.
import { tokens as sepoliaStkTokens } from './deployments/sepolia-stk.json';
import { midnight as sepoliaTbillMidnight, token as sepoliaTbillToken } from './deployments/sepolia-tbill.json';
import { tokens as sepoliaTestTbillTokens } from './deployments/sepolia-test-tbills.json';
import { bridgedTokens, vaultContractAddress } from './deployments/stagenet-vault.json';

/** Where a registry entry came from. */
export interface TokenSource {
  repo: string;
  commit: string;
  file: string;
}

export interface TokenEntry {
  /** The Sepolia ERC20 symbol: stkA, USDC, TBILL, TB13W, … */
  symbol: string;
  /** The ERC20's name from its Sepolia record ("Test T-Bill 13-week"), or the symbol when the
   *  records have none (USDC is Circle's token, with no record of ours). */
  name: string;
  /** The bridged token's name on Midnight: wStkA, wUSDC, TBILL, … */
  midnightName: string;
  decimals: number;
  /** Checksummed ERC20 address on Sepolia; '' when the token has no Sepolia side (local). */
  sepoliaAddress: string;
  /** The shielded colour on Midnight, 64 lowercase hex characters. */
  midnightColour: string;
  /** The vault that mints the bridged colour; '' when not bridged (local test tokens). */
  vault: string;
  source: TokenSource | null;
}

/** Sepolia's native currency, for the EVM holdings view. */
export const SEPOLIA_ETH = { symbol: 'ETH', name: 'Sepolia ether', decimals: 18 } as const;

export class TokenRegistryError extends Error {
  override name = 'TokenRegistryError';
}

export class TokenRegistry {
  readonly tokens: readonly TokenEntry[];
  private readonly byColourMap: Map<string, TokenEntry>;
  private readonly byAddressMap: Map<string, TokenEntry>;

  constructor(
    readonly network: NetworkName,
    tokens: readonly TokenEntry[],
  ) {
    if (tokens.length === 0) throw new TokenRegistryError('a registry needs at least one token');
    this.byColourMap = new Map();
    this.byAddressMap = new Map();
    const names = new Set<string>();
    const symbols = new Set<string>();
    for (const t of tokens) {
      if (!Number.isInteger(t.decimals) || t.decimals < 0 || t.decimals > 18) {
        throw new TokenRegistryError(`${t.midnightName}: decimals ${t.decimals} out of range`);
      }
      if (this.byColourMap.has(t.midnightColour)) throw new TokenRegistryError(`duplicate colour ${t.midnightColour}`);
      if (names.has(t.midnightName)) throw new TokenRegistryError(`duplicate token name ${t.midnightName}`);
      if (symbols.has(t.symbol)) throw new TokenRegistryError(`duplicate symbol ${t.symbol}`);
      names.add(t.midnightName);
      symbols.add(t.symbol);
      this.byColourMap.set(t.midnightColour, t);
      if (t.sepoliaAddress !== '') {
        const key = t.sepoliaAddress.toLowerCase();
        if (this.byAddressMap.has(key)) throw new TokenRegistryError(`duplicate Sepolia address ${t.sepoliaAddress}`);
        this.byAddressMap.set(key, t);
      }
    }
    this.tokens = Object.freeze([...tokens]);
  }

  /** The entry for a Midnight colour (any hex case, with or without 0x), or undefined. */
  byColour(colour: string): TokenEntry | undefined {
    try {
      return this.byColourMap.get(normaliseHex32(colour));
    } catch {
      return undefined;
    }
  }

  bySepoliaAddress(address: string): TokenEntry | undefined {
    return this.byAddressMap.get(address.toLowerCase());
  }

  byMidnightName(name: string): TokenEntry | undefined {
    return this.tokens.find((t) => t.midnightName === name);
  }

  bySymbol(symbol: string): TokenEntry | undefined {
    return this.tokens.find((t) => t.symbol === symbol);
  }

  /** Whether the vault carries this colour both ways: a token with a vault and a Sepolia side. */
  isBridgeable(colour: string): boolean {
    const t = this.byColour(colour);
    return !!t && t.vault !== '' && t.sepoliaAddress !== '';
  }
}

// ── The stagenet registry, from the vendored vault records ──────────────────

export const STAGENET_SOURCE: TokenSource = {
  repo: 'acedward/passport',
  commit: '6c7505a4d2ec223fce5eb10266c331576805465a',
  file: 'contract/contracts/erc20-vault/deployments/stagenet-vault.json',
};

interface SepoliaRecord {
  symbol: string;
  name: string;
  decimals: number;
  address: string;
  midnightColour: string;
  vault: string;
}

/** Every token the vendored Sepolia records describe, in one shape. */
function sepoliaRecords(): SepoliaRecord[] {
  return [
    ...sepoliaStkTokens.map((t) => ({
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      address: t.address,
      midnightColour: t.midnightColour,
      vault: t.midnightVault,
    })),
    {
      symbol: sepoliaTbillToken.symbol,
      name: sepoliaTbillToken.name,
      decimals: sepoliaTbillToken.decimals,
      address: sepoliaTbillToken.address,
      midnightColour: sepoliaTbillMidnight.midnightColour,
      vault: sepoliaTbillMidnight.vault,
    },
    ...sepoliaTestTbillTokens.map((t) => ({
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      address: t.address,
      midnightColour: t.midnight.midnightColour,
      vault: t.midnight.vault,
    })),
  ];
}

export function stagenetRegistry(): TokenRegistry {
  const vault = normaliseHex32(vaultContractAddress);
  const records = new Map(sepoliaRecords().map((r) => [r.address.toLowerCase(), r]));
  const tokens = bridgedTokens.map((b): TokenEntry => {
    const colour = normaliseHex32(b.midnightColour);
    const sepolia = records.get(b.erc20Address.toLowerCase());
    if (
      sepolia &&
      (sepolia.symbol !== b.erc20 ||
        sepolia.decimals !== b.decimals ||
        normaliseHex32(sepolia.midnightColour) !== colour ||
        normaliseHex32(sepolia.vault) !== vault)
    ) {
      throw new TokenRegistryError(`${b.erc20}: the Sepolia record and stagenet-vault.json disagree`);
    }
    return {
      symbol: b.erc20,
      name: sepolia?.name ?? b.erc20,
      midnightName: b.midnightName,
      decimals: b.decimals,
      sepoliaAddress: getAddress(b.erc20Address),
      midnightColour: colour,
      vault,
      source: STAGENET_SOURCE,
    };
  });
  return new TokenRegistry('stagenet', tokens);
}

// ── Registries from configuration (the local stack, or an owner override) ───

export const TokenConfigSchema = z.object({
  tokens: z
    .array(
      z.object({
        symbol: z.string().min(1),
        name: z.string().min(1).optional(),
        midnightName: z.string().min(1),
        decimals: z.number().int().min(0).max(18),
        sepoliaAddress: z
          .string()
          .regex(/^(0x[0-9a-fA-F]{40})?$/)
          .default(''),
        midnightColour: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/),
        vault: z
          .string()
          .regex(/^([0-9a-fA-F]{64})?$/)
          .default(''),
      }),
    )
    .min(1),
});
export type TokenConfig = z.input<typeof TokenConfigSchema>;

/** Build a registry from JSON configuration (for example the local stack's test colours). */
export function registryFromConfig(network: NetworkName, config: unknown): TokenRegistry {
  const parsed = TokenConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new TokenRegistryError(`invalid token configuration: ${issues}`);
  }
  return new TokenRegistry(
    network,
    parsed.data.tokens.map((t) => ({
      ...t,
      name: t.name ?? t.symbol,
      sepoliaAddress: t.sepoliaAddress === '' ? '' : getAddress(t.sepoliaAddress),
      midnightColour: normaliseHex32(t.midnightColour),
      vault: t.vault === '' ? '' : normaliseHex32(t.vault),
      source: null,
    })),
  );
}

/** The registry for a network: stagenet's from the vendored records unless configuration is
 *  given; the local stack always needs configuration. */
export function registryFor(network: NetworkName, config?: unknown): TokenRegistry {
  if (config !== undefined) return registryFromConfig(network, config);
  if (network === 'stagenet') return stagenetRegistry();
  throw new TokenRegistryError(`the ${network} network has no built-in token list; pass a token configuration`);
}

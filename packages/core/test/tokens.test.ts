import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  STAGENET_SOURCE,
  TokenRegistryError,
  registryFor,
  registryFromConfig,
  stagenetRegistry,
} from '../src/tokens/registry.js';

const file = (rel: string) => fileURLToPath(new URL(`../src/${rel}`, import.meta.url));
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

const VAULT = '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637';

/** The vault's tokens at acedward/passport @ 6c7505a, written out by hand from its records. */
const EXPECTED = [
  {
    symbol: 'stkA',
    midnightName: 'wStkA',
    sepoliaAddress: '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52',
    midnightColour: '5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02',
  },
  {
    symbol: 'stkB',
    midnightName: 'wStkB',
    sepoliaAddress: '0xF2bEFf36543219C8feC2AB2f42070AA65D3C844B',
    midnightColour: 'e7ca18cb056477a5aca5cce387306d56526c2f226b4a4e34f068e3a3e8179588',
  },
  {
    symbol: 'stkC',
    midnightName: 'wStkC',
    sepoliaAddress: '0x70c5c1978e5d428fa5C82111980e1aF0A64a270D',
    midnightColour: 'db8ae472c587a0709094eeaf98b81a0d46752db1a807e77bd209814e808f19d9',
  },
  {
    symbol: 'USDC',
    midnightName: 'wUSDC',
    sepoliaAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    midnightColour: 'e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d',
  },
  {
    symbol: 'TBILL',
    midnightName: 'TBILL',
    sepoliaAddress: '0x1531b11722CF9b600816ED0eAcBc49594DbB991f',
    midnightColour: '05b32284398b1a75dac4f92dcb8802a57ce2194dd3cae781f870430c18a8a8e9',
  },
  {
    symbol: 'TB13W',
    midnightName: 'TB13W',
    sepoliaAddress: '0x5cF366decA552c30eBB2504d0b9Ee104A99f1c72',
    midnightColour: 'b3d96e9933fb4548ce8a17a63f4c92bb3894b3571873c3edcc8a08aa7ce2512b',
  },
  {
    symbol: 'TB26W',
    midnightName: 'TB26W',
    sepoliaAddress: '0x26dB7221903e62310409e454442adBb46E0B6E33',
    midnightColour: '7b044b55c0493a67eeb16f25d3757eea07f9abaf55e374739953afd449bc3b62',
  },
  {
    symbol: 'TB52W',
    midnightName: 'TB52W',
    sepoliaAddress: '0x02A0D1BaF66351715A84aC4763b82f1155BdD5b0',
    midnightColour: '8f4798a5ee48747f37562da76ed8711ad4b4ea1ad7ac16d80eb74b92792b9ec2',
  },
];

describe('vendored vault records', () => {
  it('are byte-identical to acedward/passport @ 6c7505a (PROVENANCE.md)', () => {
    expect(sha256(file('tokens/deployments/stagenet-vault.json'))).toBe(
      '8897b1eeb72bff8a5dd7038aca9556cc9308246352ef7e0a277a2f5024453a67',
    );
    expect(sha256(file('tokens/deployments/sepolia-stk.json'))).toBe(
      '0c9718001ad5e58ef7fb46de740ba1c9cd452d5257a465c6a4ada99918e7bee7',
    );
    expect(sha256(file('tokens/deployments/sepolia-tbill.json'))).toBe(
      'a34a79ca392d42a76ebcec0abb1cf023a059a0020a04f2dbf18a53ba64be839e',
    );
    expect(sha256(file('tokens/deployments/sepolia-test-tbills.json'))).toBe(
      '19e6a25d915ab9bd896b8e591a53a2f6bc187f0724fc412ec631040a4d10d672',
    );
    expect(sha256(file('vendor/vault-preflight.ts'))).toBe(
      'fe0c2ef038ce67219a257617c28a323eb9269ba56281a183b505bd52a31b32da',
    );
    expect(STAGENET_SOURCE.commit).toBe('6c7505a4d2ec223fce5eb10266c331576805465a');
  });
});

describe('the stagenet registry', () => {
  const r = stagenetRegistry();

  it('lists the 8 vault tokens, all 6 decimals, with the pinned colours and addresses', () => {
    expect(r.tokens).toHaveLength(8);
    expect(
      r.tokens.map((t) => ({
        symbol: t.symbol,
        midnightName: t.midnightName,
        sepoliaAddress: t.sepoliaAddress,
        midnightColour: t.midnightColour,
      })),
    ).toEqual(EXPECTED);
    for (const t of r.tokens) {
      expect(t.decimals).toBe(6);
      expect(t.vault).toBe(VAULT);
      expect(t.source).toEqual(STAGENET_SOURCE);
      expect(r.isBridgeable(t.midnightColour)).toBe(true);
    }
  });

  it('has no special token: no roles, no quote currency, no pair rules', () => {
    for (const t of r.tokens)
      expect(Object.keys(t).sort()).toEqual([
        'decimals',
        'midnightColour',
        'midnightName',
        'name',
        'sepoliaAddress',
        'source',
        'symbol',
        'vault',
      ]);
    const api = Object.getOwnPropertyNames(Object.getPrototypeOf(r));
    for (const name of ['usdc', 'stocks', 'isTradablePair', 'quote']) expect(api).not.toContain(name);
  });

  it('takes each ERC20 name from its Sepolia record, and the symbol when there is none', () => {
    expect(r.bySymbol('stkA')?.name).toBe('stkA');
    expect(r.bySymbol('TBILL')?.name).toBe('T-Bill');
    expect(r.bySymbol('TB13W')?.name).toBe('Test T-Bill 13-week');
    expect(r.bySymbol('TB52W')?.name).toBe('Test T-Bill 52-week');
    expect(r.bySymbol('USDC')?.name).toBe('USDC');
  });

  it('looks tokens up by colour, address, Midnight name and symbol, in any case', () => {
    expect(r.byColour('0x5EB2A3CEBB2EBE7BA910C78F62C9E28E0D74ACBD00C810730DEF3578860E6A02')?.midnightName).toBe(
      'wStkA',
    );
    expect(r.byColour('not hex')).toBeUndefined();
    expect(r.bySepoliaAddress('0x1531b11722cf9b600816ed0eacbc49594dbb991f')?.symbol).toBe('TBILL');
    expect(r.byMidnightName('wUSDC')?.symbol).toBe('USDC');
    expect(r.bySymbol('TB26W')?.midnightName).toBe('TB26W');
    expect(r.isBridgeable('11'.repeat(32))).toBe(false);
  });
});

describe('registries from configuration (a local stack)', () => {
  const local = {
    tokens: [
      { symbol: 'tA', midnightName: 'shielded-a', decimals: 6, midnightColour: 'aa'.repeat(32) },
      {
        symbol: 'tB',
        name: 'Token B',
        midnightName: 'shielded-b',
        decimals: 6,
        midnightColour: `0x${'BB'.repeat(32)}`,
        sepoliaAddress: '0x0000000000000000000000000000000000000001',
        vault: 'cc'.repeat(32),
      },
    ],
  };

  it('normalises colours, and only a token with a vault and a Sepolia side is bridgeable', () => {
    const r = registryFromConfig('undeployed', local);
    expect(r.bySymbol('tA')?.name).toBe('tA');
    expect(r.bySymbol('tB')?.midnightColour).toBe('bb'.repeat(32));
    expect(r.bySymbol('tA')?.source).toBeNull();
    expect(r.isBridgeable('aa'.repeat(32))).toBe(false);
    expect(r.isBridgeable('bb'.repeat(32))).toBe(true);
  });

  it('the local network has no built-in list', () => {
    expect(() => registryFor('undeployed')).toThrow(TokenRegistryError);
    expect(registryFor('undeployed', local).network).toBe('undeployed');
    expect(registryFor('stagenet').tokens).toHaveLength(8);
  });

  it('refuses an empty list, duplicates and bad values', () => {
    const [a, b] = local.tokens as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(() => registryFromConfig('undeployed', { tokens: [] })).toThrow(TokenRegistryError);
    expect(() => registryFromConfig('undeployed', { tokens: [a, { ...b, midnightColour: 'aa'.repeat(32) }] })).toThrow(
      /duplicate colour/,
    );
    expect(() => registryFromConfig('undeployed', { tokens: [a, { ...b, symbol: 'tA' }] })).toThrow(/duplicate symbol/);
    expect(() => registryFromConfig('undeployed', { tokens: [a, { ...b, decimals: 19 }] })).toThrow(TokenRegistryError);
    expect(() => registryFromConfig('undeployed', { tokens: [a, { ...b, midnightColour: 'zz' }] })).toThrow(
      TokenRegistryError,
    );
  });
});

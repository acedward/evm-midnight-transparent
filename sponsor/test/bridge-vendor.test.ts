import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as sdk from '../src/bridge/vendor/signet-sdk.js';

// sha256 of acedward/passport @ 6c7505a `contract/contracts/erc20-vault/src/relayer.ts` (identical at
// 51c1fb4 and 07d8ea4).
const UPSTREAM_RELAYER_SHA256 = '62181eaf6e8fb83af98a13563f3da779cb3c5605f509e0629cc9b0b7c0c4cad2';
const MARKER = '// ---- upstream relayer.ts below this line ----\n';

describe('the vendored bridge code', () => {
  it('keeps the vault relayer byte for byte below its header', () => {
    const text = readFileSync(fileURLToPath(new URL('../src/bridge/vendor/relayer.ts', import.meta.url)), 'utf8');
    const i = text.indexOf(MARKER);
    expect(i).toBeGreaterThan(0);
    const upstream = text.slice(i + MARKER.length);
    expect(createHash('sha256').update(upstream).digest('hex')).toBe(UPSTREAM_RELAYER_SHA256);
  });

  it('reaches @sig-net/midnight 0.23.0 through the root install', () => {
    expect(sdk.SIG_NET_MIDNIGHT_VERSION).toBe('0.23.0');
    for (const name of [
      'serializeRespondOutput',
      'bytesToHex',
      'getMpcRootPublicKey',
      'deriveEvmAddress',
      'deriveMidnightResponseKey',
      'MpcOutputCacheReader',
      'signetEventSourceFromIndexer',
      'SignetRequestResponseReader',
      'toSignBidirectionalEventIndex',
      'verifyRespondBidirectionalSignature',
    ] as const) {
      expect(sdk[name], name).toBeDefined();
    }
    expect(sdk.normaliseSecp256k1PublicKey(sdk.getMpcRootPublicKey('stagenet' as never))).toBe(
      '0x047dd8ecafa5d9c921485b6ac33476870e98c3378e395f3c8fae92ce4943d8432847f591ab25ca454effb522ec2eaf04b7e1c83ba65ae731ea98dd52eb7d458dd4',
    );
  });
});

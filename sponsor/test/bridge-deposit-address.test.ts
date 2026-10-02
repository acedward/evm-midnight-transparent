import { randomBytes } from 'node:crypto';

import {
  CompactTypeBoolean,
  CompactTypeBytes,
  persistentHash,
  type CompactType,
} from '@midnight-ntwrk/compact-runtime';
import { describe, expect, it } from 'vitest';

import { depositAddressFor, depositPathOf, walletRecipient } from '@evm-midnight-transparent/core';

import vaultRecord from '../../packages/core/src/tokens/deployments/stagenet-vault.json';
import { encryptionKeyMapping } from '../src/bridge/vault.js';
import { bytesToHex, deriveEvmAddress } from '../src/bridge/vendor/signet-sdk.js';

// The deposit address lives in core (packages/core/src/deposit-address.ts, with the 00037 and G-BRIDGE
// vectors as unit tests there). Core computes it without WASM: `depositPath` as plain SHA-256 and the
// MPC epsilon derivation with ethers. Here, where the sponsor already has both, the two halves are
// checked against the originals the G-BRIDGE gate used: compact-runtime's own `persistentHash` with the
// vault's tuple descriptor, and `@sig-net/midnight`'s `deriveEvmAddress`.

const bytes32 = new CompactTypeBytes(32);
/** The vault's compiled descriptor for `[Bytes<32>, Boolean, Bytes<32>, Bytes<32>]`. */
const depositPathTuple: CompactType<[Uint8Array, boolean, Uint8Array, Uint8Array]> = {
  alignment: () =>
    bytes32.alignment().concat(CompactTypeBoolean.alignment().concat(bytes32.alignment().concat(bytes32.alignment()))),
  fromValue: (v) => [bytes32.fromValue(v), CompactTypeBoolean.fromValue(v), bytes32.fromValue(v), bytes32.fromValue(v)],
  toValue: (t) =>
    bytes32
      .toValue(t[0])
      .concat(CompactTypeBoolean.toValue(t[1]).concat(bytes32.toValue(t[2]).concat(bytes32.toValue(t[3])))),
};
const TAG = (() => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode('vault:deposit-path:v1'));
  return out;
})();

const randomKey = (i: number): Uint8Array => {
  const k = new Uint8Array(randomBytes(32));
  if (i % 5 === 0) k.fill(0, 24); // trailing zero bytes: the aligned encoding must keep them
  return k;
};

describe("core's deposit address against the originals", () => {
  it('depositPath equals compact-runtime persistentHash of the vault tuple (both recipient kinds)', () => {
    for (let i = 0; i < 64; i++) {
      const key = randomKey(i);
      const isLeft = i % 2 === 0;
      const recipient = isLeft
        ? { is_left: true, left: { bytes: key }, right: { bytes: new Uint8Array(32) } }
        : { is_left: false, left: { bytes: new Uint8Array(32) }, right: { bytes: key } };
      const want = persistentHash(depositPathTuple, [TAG, isLeft, recipient.left.bytes, recipient.right.bytes]);
      expect(bytesToHex(depositPathOf(recipient))).toBe(bytesToHex(want));
    }
  });

  it("the address equals @sig-net/midnight's deriveEvmAddress over the compact-runtime path", () => {
    for (let i = 0; i < 16; i++) {
      const cpk = bytesToHex(randomKey(i));
      const path = persistentHash(depositPathTuple, [TAG, true, walletRecipient(cpk).left.bytes, new Uint8Array(32)]);
      expect(depositAddressFor(vaultRecord.mpcRootPublicKey, vaultRecord.vaultContractAddress, cpk)).toBe(
        deriveEvmAddress(vaultRecord.mpcRootPublicKey, vaultRecord.vaultContractAddress, bytesToHex(path)),
      );
    }
  });
});

describe('the encryption-key mapping for a third-party mint', () => {
  it('normalises both keys to lowercase hex without a prefix', () => {
    const m = encryptionKeyMapping(`0x${'AB'.repeat(32)}`, `0X${'CD'.repeat(32)}`);
    expect([...m.entries()]).toEqual([['ab'.repeat(32), 'cd'.repeat(32)]]);
  });
});

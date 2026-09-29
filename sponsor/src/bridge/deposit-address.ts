// A swap's Sepolia deposit address, computed offline from the temporary wallet's coin public key.
//
// The vault (acedward/passport PR #4 @ 6c7505a, `contract/contracts/erc20-vault/src/erc20-vault.compact`)
// binds a deposit to its recipient through the MPC key-derivation path
//
//   depositPath(recipient) = persistentHash<[Bytes<32>, Boolean, Bytes<32>, Bytes<32>]>(
//     [pad(32, "vault:deposit-path:v1"), recipient.is_left, recipient.left.bytes, recipient.right.bytes])
//
// and the depositor funds `deriveEvmAddress(mpcRoot, vault, lowercaseHex(depositPath(left(coinPk))))`.
// This module is the TypeScript twin of that pure circuit: the same tuple, hashed with compact-runtime's
// own `persistentHash` and the same runtime type descriptors the compiled contract builds, so it needs
// neither the compiled vault module nor any network. Nothing here is Node-specific; L-WALLET moves it
// next to the browser's temporary wallet.
//
// It is checked three ways: against the compiled circuit (`pureCircuits.depositPath`, the vault's own
// helper `deriveDepositEvmAddress`) by the G-BRIDGE gate, and against AA 00037's recorded worked example
// by test/deposit-address.test.ts.

import {
  CompactTypeBoolean,
  CompactTypeBytes,
  persistentHash,
  type CompactType,
} from '@midnight-ntwrk/compact-runtime';

import { bytesToHex, deriveEvmAddress } from './vendor/signet-sdk.js';

/** `Either<ZswapCoinPublicKey, ContractAddress>` as the generated code shapes it. */
export interface EitherRecipient {
  readonly is_left: boolean;
  readonly left: { readonly bytes: Uint8Array };
  readonly right: { readonly bytes: Uint8Array };
}

const bytes32 = new CompactTypeBytes(32);

/** The compiled contract's tuple descriptor for `[Bytes<32>, Boolean, Bytes<32>, Bytes<32>]`. */
const depositPathTuple: CompactType<[Uint8Array, boolean, Uint8Array, Uint8Array]> = {
  alignment: () =>
    bytes32.alignment().concat(CompactTypeBoolean.alignment().concat(bytes32.alignment().concat(bytes32.alignment()))),
  fromValue: (v) => [bytes32.fromValue(v), CompactTypeBoolean.fromValue(v), bytes32.fromValue(v), bytes32.fromValue(v)],
  toValue: (t) =>
    bytes32
      .toValue(t[0])
      .concat(CompactTypeBoolean.toValue(t[1]).concat(bytes32.toValue(t[2]).concat(bytes32.toValue(t[3])))),
};

/** `pad(32, "vault:deposit-path:v1")`. */
const DEPOSIT_PATH_TAG = (() => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode('vault:deposit-path:v1'));
  return out;
})();

export function hexBytes(hex: string, length?: number): Uint8Array {
  const h = hex.replace(/^0x/i, '');
  if (!/^([0-9a-fA-F]{2})*$/.test(h)) throw new Error('not a hex string');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  if (length !== undefined && out.length !== length) throw new Error(`expected ${length} bytes, got ${out.length}`);
  return out;
}

/** `left(coinPublicKey)`: a wallet recipient. */
export function walletRecipient(coinPublicKeyHex: string): EitherRecipient {
  return { is_left: true, left: { bytes: hexBytes(coinPublicKeyHex, 32) }, right: { bytes: new Uint8Array(32) } };
}

/** The 32-byte MPC derivation path of a deposit for `recipient` (the vault's `depositPath`). */
export function depositPathOf(recipient: EitherRecipient): Uint8Array {
  return persistentHash(depositPathTuple, [
    DEPOSIT_PATH_TAG,
    recipient.is_left,
    recipient.left.bytes,
    recipient.right.bytes,
  ]);
}

/**
 * The Sepolia address a depositor funds so that the vault mints to `coinPublicKeyHex`. The MPC renders
 * the path as the lowercase hex of all 32 bytes; any other rendering derives an account it never signs
 * from.
 */
export function depositAddressFor(mpcRootPublicKey: string, vaultAddressHex: string, coinPublicKeyHex: string): string {
  return deriveEvmAddress(
    mpcRootPublicKey,
    vaultAddressHex.replace(/^0x/i, '').toLowerCase(),
    bytesToHex(depositPathOf(walletRecipient(coinPublicKeyHex))),
  );
}

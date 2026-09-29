// A swap's Sepolia deposit address, computed offline from the temporary wallet's coin public key.
// Shared by the browser (the swap page shows it and checks the sponsor's copy) and the sponsor
// (it watches it and starts the deposit).
//
// The vault (acedward/passport PR #4 @ 6c7505a, `contract/contracts/erc20-vault/src/erc20-vault.compact`)
// binds a deposit to its recipient through the MPC key-derivation path
//
//   depositPath(recipient) = persistentHash<[Bytes<32>, Boolean, Bytes<32>, Bytes<32>]>(
//     [pad(32, "vault:deposit-path:v1"), recipient.is_left, recipient.left.bytes, recipient.right.bytes])
//
// and the depositor funds `deriveEvmAddress(mpcRoot, vault, lowercaseHex(depositPath(left(coinPk))))`.
//
// This is the TypeScript twin of that pure circuit and of Sig Network's epsilon derivation
// (`@sig-net/midnight` 0.23.0 `dist/epsilon-derivation.js`), with no WASM and no network:
//   - compact-runtime's `persistentHash` of this tuple is SHA-256 over its field-aligned bytes, which
//     for `[Bytes<32>, Boolean, Bytes<32>, Bytes<32>]` is `tag(32) ‖ is_left(1) ‖ left(32) ‖ right(32)`
//     (sponsor/test/bridge-deposit-address.test.ts checks this against compact-runtime itself, and the
//     sig-net derivation against the package's own function, on random keys);
//   - the MPC's key for a request is `mpcRoot + epsilon·G` with
//     `epsilon = keccak256("sig.network v2.0.0 epsilon derivation:midnight:mainnet:<vault>:<path>") mod n`,
//     and its EVM account is the usual keccak of that public key.
// Moved here from the sponsor (G-BRIDGE `sponsor/src/bridge/deposit-address.ts`, which used the
// compact-runtime and sig-net functions directly) by L-WALLET; the vectors are the same.

import { sha256 } from '@noble/hashes/sha2.js';
import { SigningKey, computeAddress, getAddress, keccak256, toUtf8Bytes } from 'ethers';

import { bytesToHex, hexToBytes } from './hex.js';
import { type NetworkProfile } from './network.js';

export class DepositAddressError extends Error {
  override name = 'DepositAddressError';
}

/** `Either<ZswapCoinPublicKey, ContractAddress>` as the vault's generated code shapes it. */
export interface EitherRecipient {
  readonly is_left: boolean;
  readonly left: { readonly bytes: Uint8Array };
  readonly right: { readonly bytes: Uint8Array };
}

/** `pad(32, "vault:deposit-path:v1")`. */
const DEPOSIT_PATH_TAG = (() => {
  const out = new Uint8Array(32);
  out.set(new TextEncoder().encode('vault:deposit-path:v1'));
  return out;
})();

/** Sig Network's v2.0.0 derivation string prefix and Midnight's fixed CAIP-2 id (MPC `kdf.rs`). */
export const EPSILON_DERIVATION_PREFIX = 'sig.network v2.0.0 epsilon derivation';
export const MIDNIGHT_CAIP2_ID = 'midnight:mainnet';
const SECP256K1_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

const bytes32 = (label: string, hex: string): Uint8Array => {
  try {
    return hexToBytes(hex, 32);
  } catch {
    throw new DepositAddressError(`the ${label} must be 32 bytes of hex`);
  }
};

/** `left(coinPublicKey)`: a wallet recipient. */
export function walletRecipient(coinPublicKeyHex: string): EitherRecipient {
  return {
    is_left: true,
    left: { bytes: bytes32('coin public key', coinPublicKeyHex) },
    right: { bytes: new Uint8Array(32) },
  };
}

/** The 32-byte MPC derivation path of a deposit for `recipient` (the vault's `depositPath`). */
export function depositPathOf(recipient: EitherRecipient): Uint8Array {
  if (recipient.left.bytes.length !== 32 || recipient.right.bytes.length !== 32) {
    throw new DepositAddressError('a recipient is two 32-byte values');
  }
  const preimage = new Uint8Array(97);
  preimage.set(DEPOSIT_PATH_TAG, 0);
  preimage[32] = recipient.is_left ? 1 : 0;
  preimage.set(recipient.left.bytes, 33);
  preimage.set(recipient.right.bytes, 65);
  return sha256(preimage);
}

/** The epsilon scalar for (requester, path): keccak256 of the derivation string, mod the curve order. */
export function mpcEpsilon(requester: string, path: string): bigint {
  return (
    BigInt(keccak256(toUtf8Bytes(`${EPSILON_DERIVATION_PREFIX}:${MIDNIGHT_CAIP2_ID}:${requester}:${path}`))) %
    SECP256K1_ORDER
  );
}

/**
 * The EVM account the MPC signs from for a request of `contractAddressHex` with `pathText` (the MPC's
 * rendering of a 32-byte path is its lowercase hex, all 32 bytes, no 0x). EIP-55 checksummed.
 */
export function mpcDerivedEvmAddress(mpcRootPublicKey: string, contractAddressHex: string, pathText: string): string {
  let root: string;
  try {
    root = SigningKey.computePublicKey(mpcRootPublicKey, false);
  } catch {
    throw new DepositAddressError('the MPC root key is not a secp256k1 public key');
  }
  const requester = contractAddressHex.replace(/^0x/i, '').toLowerCase();
  const epsilon = mpcEpsilon(requester, pathText);
  const child =
    epsilon === 0n
      ? root
      : SigningKey.addPoints(root, SigningKey.computePublicKey(`0x${epsilon.toString(16).padStart(64, '0')}`, false));
  return getAddress(computeAddress(child));
}

/**
 * The Sepolia address a depositor funds so that the vault mints to `coinPublicKeyHex`. The MPC renders
 * the path as the lowercase hex of all 32 bytes; any other rendering derives an account it never signs
 * from.
 */
export function depositAddressFor(mpcRootPublicKey: string, vaultAddressHex: string, coinPublicKeyHex: string): string {
  const vault = bytesToHex(bytes32('vault address', vaultAddressHex));
  return mpcDerivedEvmAddress(mpcRootPublicKey, vault, bytesToHex(depositPathOf(walletRecipient(coinPublicKeyHex))));
}

/** `depositAddressFor` with the vault and MPC root of a network profile. */
export function swapDepositAddress(profile: Pick<NetworkProfile, 'bridge'>, coinPublicKeyHex: string): string {
  const { mpcRootPublicKey, vaultAddress } = profile.bridge;
  if (mpcRootPublicKey === '' || vaultAddress === '') {
    throw new DepositAddressError('the network profile names no vault or MPC root key');
  }
  return depositAddressFor(mpcRootPublicKey, vaultAddress, coinPublicKeyHex);
}

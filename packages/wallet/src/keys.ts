// The temporary wallet's Midnight keys, from the swap seed (`@evm-midnight-transparent/core`
// swap-key.ts: seed = keccak256 of the "start swap" signature).
//
// The seed goes through the standard Midnight HD layout, as the Midnight wallets and this repo's
// sponsor derive theirs: account 0, key index 0, roles Zswap, NightExternal and Dust. So the seed
// also restores the wallet in any Midnight tool that accepts a 32-byte seed.
//
// Only the Zswap keys are used by a swap: the temporary wallet holds shielded coins only, never
// NIGHT or DUST. The Dust key exists because the SDK's balancing calls take one; the NightExternal
// key gives the unshielded address that names the submitter in the batcher's envelope.
//
// Everything secret here stays in session memory: call `clear()` when the swap ends.

import * as ledger from '@midnightntwrk/ledger-v9';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';

import { bytesToHex, formatShieldedAddress, formatUnshieldedAddress, hexToBytes } from '@evm-midnight-transparent/core';

export class WalletKeyError extends Error {
  override name = 'WalletKeyError';
}

export interface TemporaryWalletKeys {
  network: string;
  /** SECRET. */
  readonly shieldedSecretKeys: ledger.ZswapSecretKeys;
  /** SECRET (unused by a swap: the wallet never holds DUST). */
  readonly dustSecretKey: ledger.DustSecretKey;
  /** Public: owns the wallet's shielded coins (64 hex). */
  coinPublicKey: string;
  /** Public: coins sent to the wallet are sealed to it (64 hex). */
  encryptionPublicKey: string;
  /** `mn_shield-addr_<network>1…`: where shielded coins are sent. */
  shieldedAddress: string;
  /** `mn_addr_<network>1…`: the submitter named in the batcher's envelope. */
  unshieldedAddress: string;
  /** The 32-byte user address behind `unshieldedAddress` (64 hex). */
  unshieldedAddressHex: string;
  /** Wipe the secret keys from memory. */
  clear(): void;
}

/** The three role keys at account 0, index 0. SECRET; the HD wallet is cleared after use. */
export function deriveRoleKeys(seed: Uint8Array): { zswap: Uint8Array; night: Uint8Array; dust: Uint8Array } {
  const created = HDWallet.fromSeed(seed);
  if (created.type !== 'seedOk') throw new WalletKeyError('the swap seed is not a valid HD seed');
  const derived = created.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  created.hdWallet.clear();
  if (derived.type !== 'keysDerived') throw new WalletKeyError('the temporary wallet keys could not be derived');
  return { zswap: derived.keys[Roles.Zswap], night: derived.keys[Roles.NightExternal], dust: derived.keys[Roles.Dust] };
}

/** The temporary wallet's keys and public addresses from the swap seed (64 hex, SECRET). */
export function temporaryWalletKeys(seedHex: string, network: string): TemporaryWalletKeys {
  let seed: Uint8Array;
  try {
    seed = hexToBytes(seedHex, 32);
  } catch {
    throw new WalletKeyError('the swap seed must be 32 bytes of hex');
  }
  const roles = deriveRoleKeys(seed);
  seed.fill(0);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(roles.zswap);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(roles.dust);
  const verifyingKey = ledger.signatureVerifyingKey({ tag: 'schnorr', value: bytesToHex(roles.night) });
  roles.zswap.fill(0);
  roles.night.fill(0);
  roles.dust.fill(0);
  const coinPublicKey = String(shieldedSecretKeys.coinPublicKey).toLowerCase();
  const encryptionPublicKey = String(shieldedSecretKeys.encryptionPublicKey).toLowerCase();
  const unshieldedAddressHex = String(ledger.addressFromKey(verifyingKey)).toLowerCase();
  return {
    network,
    shieldedSecretKeys,
    dustSecretKey,
    coinPublicKey,
    encryptionPublicKey,
    shieldedAddress: formatShieldedAddress({ coinPublicKey, encryptionPublicKey }, network),
    unshieldedAddress: formatUnshieldedAddress(unshieldedAddressHex, network),
    unshieldedAddressHex,
    clear() {
      shieldedSecretKeys.clear();
      dustSecretKey.clear();
    },
  };
}

import { readFileSync } from 'node:fs';

import {
  MidnightBech32m,
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
  UnshieldedAddress,
} from '@midnightntwrk/wallet-sdk-address-format';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { describe, expect, it } from 'vitest';

import { deriveSwapSeed, parseShieldedAddress, type StartSwapSigner } from '@evm-midnight-transparent/core';

import { WalletKeyError, temporaryWalletKeys } from '../src/keys.js';

// The core test's fixed vector (packages/core/test/swap-key.test.ts): the PUBLIC test signer's
// "start swap" signature over salt keccak256("salt 1") gives this seed.
const SEED = '9d3a761d3aeeb6dc5a6a565b4c036d809613daea7b294509fee2225555c4e3d8';
const KEYS = {
  coinPublicKey: '9d253493498d071a4a4aa56797b06b0c85badc676cc3b2742db12a36fa7c73b5',
  encryptionPublicKey: 'f19fff83503564692e658c0aad74e91bf9e19c589cd5e9ea554a749f2079e657',
  shieldedAddress:
    'mn_shield-addr_stagenet1n5jnfy6f35r35jj254ne0vrtpjzm4hr8dnpmyapdky4rd7nuww6lr8llsdgr2erf9ejccz4dwn53h70pn3vfe40faf255aylypu7v4cr5fyes',
  unshieldedAddress: 'mn_addr_stagenet14m6tum6n4nhjnystcxc88dlqwtns56t0tqwp00xyc65cng0r7hvqg4f0jg',
  unshieldedAddressHex: 'aef4be6f53acef29920bc1b073b7e072e70a696f581c17bcc4c6a989a1e3f5d8',
};

describe('the temporary wallet keys', () => {
  it('derive the fixed vector from the fixed seed', () => {
    const k = temporaryWalletKeys(SEED, 'stagenet');
    expect({
      coinPublicKey: k.coinPublicKey,
      encryptionPublicKey: k.encryptionPublicKey,
      shieldedAddress: k.shieldedAddress,
      unshieldedAddress: k.unshieldedAddress,
      unshieldedAddressHex: k.unshieldedAddressHex,
    }).toEqual(KEYS);
    k.clear();
  });

  it('encode both addresses exactly as the wallet SDK does', () => {
    const k = temporaryWalletKeys(SEED, 'stagenet');
    const shielded = MidnightBech32m.encode(
      'stagenet',
      new ShieldedAddress(
        ShieldedCoinPublicKey.fromHexString(k.coinPublicKey),
        ShieldedEncryptionPublicKey.fromHexString(k.encryptionPublicKey),
      ),
    ).asString();
    const unshielded = MidnightBech32m.encode(
      'stagenet',
      new UnshieldedAddress(Buffer.from(k.unshieldedAddressHex, 'hex')),
    ).asString();
    expect(k.shieldedAddress).toBe(shielded);
    expect(k.unshieldedAddress).toBe(unshielded);
    expect(parseShieldedAddress(k.shieldedAddress, 'stagenet')).toEqual({
      coinPublicKey: k.coinPublicKey,
      encryptionPublicKey: k.encryptionPublicKey,
      network: 'stagenet',
    });
    k.clear();
  });

  it('end to end: signature → seed → keys, for the public test signer', async () => {
    const signer = new Wallet(keccak256(toUtf8Bytes('evm-midnight-transparent: start-swap test vector 1')));
    const sign: StartSwapSigner = async (td) => {
      const { EIP712Domain: _d, ...types } = td.types;
      return signer.signTypedData(td.domain, types, td.message);
    };
    const params = {
      network: 'stagenet',
      vault: '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637',
      salt: keccak256(toUtf8Bytes('salt 1')),
    };
    const { seedHex, deterministic } = await deriveSwapSeed(sign, params, signer.address);
    expect(deterministic).toBe(true);
    expect(seedHex).toBe(SEED);
    expect(temporaryWalletKeys(seedHex, 'stagenet').shieldedAddress).toBe(KEYS.shieldedAddress);
  });

  it('another seed is another wallet; another network another address', () => {
    const other = temporaryWalletKeys(keccak256(toUtf8Bytes('another seed')).slice(2), 'stagenet');
    expect(other.coinPublicKey).not.toBe(KEYS.coinPublicKey);
    const undeployed = temporaryWalletKeys(SEED, 'undeployed');
    expect(undeployed.coinPublicKey).toBe(KEYS.coinPublicKey);
    expect(undeployed.shieldedAddress.startsWith('mn_shield-addr_undeployed1')).toBe(true);
  });

  it('refuses a seed that is not 32 bytes of hex', () => {
    expect(() => temporaryWalletKeys('abcd', 'stagenet')).toThrow(WalletKeyError);
    expect(() => temporaryWalletKeys(`${SEED}00`, 'stagenet')).toThrow(WalletKeyError);
  });

  it('keeps no secret in its module source (no storage, no logging)', () => {
    const src = ['keys.ts', 'shielded.ts', 'take.ts', 'prover.ts']
      .map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8'))
      .join('\n');
    expect(src).not.toMatch(/localStorage|sessionStorage|indexedDB|console\./);
  });
});

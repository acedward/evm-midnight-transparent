import { describe, expect, it } from 'vitest';

import vaultRecord from '../../packages/core/src/tokens/deployments/stagenet-vault.json';
import { depositAddressFor, depositPathOf, hexBytes, walletRecipient } from '../src/bridge/deposit-address.js';
import { encryptionKeyMapping } from '../src/bridge/vault.js';
import { bytesToHex } from '../src/bridge/vendor/signet-sdk.js';

// AA 00037's recorded worked example (evidence/00037-*/deposit-address-c6a35196.json): the `.stagenet`
// wallet's coin public key on the stagenet vault, whose deposit address took three live deposits.
const VECTOR = {
  coinPublicKey: 'c6a35196428ac58a956e93e0c3c7c7df254e428a827291e9111fde7037cd34a1',
  depositPath: '4d1621ea7ac21848c188c490923f66197e3f296d415f4fe3cec05e27b3bbc064',
  depositAddress: '0x5f89AB8632a7Cf386a32a1634D4F23312c0F3714',
};

describe('the deposit address, computed offline', () => {
  it('reproduces the vault depositPath of the 00037 worked example', () => {
    expect(bytesToHex(depositPathOf(walletRecipient(VECTOR.coinPublicKey)))).toBe(VECTOR.depositPath);
  });

  it('reproduces the 00037 deposit address from the vendored vault record', () => {
    expect(vaultRecord.vaultContractAddress).toBe('7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637');
    expect(
      depositAddressFor(vaultRecord.mpcRootPublicKey, vaultRecord.vaultContractAddress, VECTOR.coinPublicKey),
    ).toBe(VECTOR.depositAddress);
  });

  it('accepts a 0x-prefixed key and refuses a short one', () => {
    expect(
      depositAddressFor(vaultRecord.mpcRootPublicKey, vaultRecord.vaultContractAddress, `0x${VECTOR.coinPublicKey}`),
    ).toBe(VECTOR.depositAddress);
    expect(() => walletRecipient('c6a351')).toThrow(/32 bytes/);
  });

  it('gives different wallets different addresses', () => {
    const other = 'ff'.repeat(32);
    expect(depositAddressFor(vaultRecord.mpcRootPublicKey, vaultRecord.vaultContractAddress, other)).not.toBe(
      VECTOR.depositAddress,
    );
  });

  it('parses hex strictly', () => {
    expect(hexBytes('0x0aff')).toEqual(new Uint8Array([10, 255]));
    expect(() => hexBytes('0xabc')).toThrow();
  });
});

describe('the encryption-key mapping for a third-party mint', () => {
  it('normalises both keys to lowercase hex without a prefix', () => {
    const m = encryptionKeyMapping(`0x${'AB'.repeat(32)}`, `0X${'CD'.repeat(32)}`);
    expect([...m.entries()]).toEqual([['ab'.repeat(32), 'cd'.repeat(32)]]);
  });
});

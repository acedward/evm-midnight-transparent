import { describe, expect, it } from 'vitest';

import {
  DepositAddressError,
  STAGENET,
  UNDEPLOYED,
  bytesToHex,
  depositAddressFor,
  depositPathOf,
  mpcDerivedEvmAddress,
  swapDepositAddress,
  walletRecipient,
} from '../src/index.js';
import vaultRecord from '../src/tokens/deployments/stagenet-vault.json';

// AA 00037's recorded worked example (evidence/00037-*/deposit-address-c6a35196.json): the `.stagenet`
// wallet's coin public key on the stagenet vault, whose deposit address took three live deposits.
const V00037 = {
  coinPublicKey: 'c6a35196428ac58a956e93e0c3c7c7df254e428a827291e9111fde7037cd34a1',
  depositPath: '4d1621ea7ac21848c188c490923f66197e3f296d415f4fe3cec05e27b3bbc064',
  depositAddress: '0x5f89AB8632a7Cf386a32a1634D4F23312c0F3714',
};

// G-BRIDGE B.1 (evidence/00048-evm-midnight-transparent/g-bridge/b1-derive.json): the temporary
// wallet whose deposit address took 1 stkA live (Sepolia tx 0x07bfed6c…e705) and was swept by the MPC.
const B1 = {
  coinPublicKey: '6ba8a1aed3a8a804227092456895673c6b26676712d06d9ac629a2fe93d72905',
  depositPath: '9199061d2be76d6e771b72cb3c79665ac11f2b53062371111178cdb6c42eeee3',
  depositAddress: '0xFA0D1f6448c87d7a5ab437492Ca5865D68C4f55F',
};

describe('the deposit address, computed offline', () => {
  it('uses the vendored vault record', () => {
    expect(vaultRecord.vaultContractAddress).toBe('7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637');
    expect(STAGENET.bridge.vaultAddress).toBe(vaultRecord.vaultContractAddress);
    expect(STAGENET.bridge.mpcRootPublicKey).toBe(vaultRecord.mpcRootPublicKey);
  });

  for (const [name, v] of [
    ['the 00037 worked example', V00037],
    ['the G-BRIDGE B.1 temporary wallet', B1],
  ] as const) {
    it(`reproduces the vault's depositPath of ${name}`, () => {
      expect(bytesToHex(depositPathOf(walletRecipient(v.coinPublicKey)))).toBe(v.depositPath);
    });

    it(`reproduces the deposit address of ${name}`, () => {
      expect(depositAddressFor(vaultRecord.mpcRootPublicKey, vaultRecord.vaultContractAddress, v.coinPublicKey)).toBe(
        v.depositAddress,
      );
      expect(swapDepositAddress(STAGENET, v.coinPublicKey)).toBe(v.depositAddress);
    });
  }

  it('accepts 0x prefixes and upper case, and refuses a short key', () => {
    expect(
      depositAddressFor(
        vaultRecord.mpcRootPublicKey,
        `0x${vaultRecord.vaultContractAddress.toUpperCase()}`,
        `0x${B1.coinPublicKey}`,
      ),
    ).toBe(B1.depositAddress);
    expect(() => walletRecipient('c6a351')).toThrow(DepositAddressError);
    expect(() => depositAddressFor('0x04', vaultRecord.vaultContractAddress, B1.coinPublicKey)).toThrow(
      DepositAddressError,
    );
  });

  it('gives different wallets different addresses, and a contract recipient a different path', () => {
    const other = 'ff'.repeat(32);
    expect(swapDepositAddress(STAGENET, other)).not.toBe(B1.depositAddress);
    const asContract = {
      is_left: false,
      left: { bytes: new Uint8Array(32) },
      right: walletRecipient(B1.coinPublicKey).left,
    };
    expect(bytesToHex(depositPathOf(asContract))).not.toBe(B1.depositPath);
  });

  it('refuses a profile without a vault', () => {
    expect(() => swapDepositAddress(UNDEPLOYED, B1.coinPublicKey)).toThrow(/no vault/);
  });

  it('derives the MPC account from the requester and path strings exactly as given', () => {
    const a = mpcDerivedEvmAddress(vaultRecord.mpcRootPublicKey, vaultRecord.vaultContractAddress, B1.depositPath);
    expect(a).toBe(B1.depositAddress);
    // The MPC renders the path as all 32 bytes of lowercase hex: another spelling is another account.
    expect(
      mpcDerivedEvmAddress(
        vaultRecord.mpcRootPublicKey,
        vaultRecord.vaultContractAddress,
        B1.depositPath.toUpperCase(),
      ),
    ).not.toBe(B1.depositAddress);
  });
});

// @vitest-environment node
// The live adapter (src/swap/live-wallet.ts) over the REAL wallet module: it derives the same seed
// as core's derivation spec, with the network bound, and the deposit address is core's. What P3 wires
// in place of the mock is this object. (Syncing and building need the network: L-WALLET's own tests
// and the P3 end-to-end runs cover them.)

import {
  STAGENET,
  startSwapTypedData,
  swapDepositAddress,
  swapSeedFromSignature,
} from '@evm-midnight-transparent/core';
import * as Wallet from '@evm-midnight-transparent/wallet';
import { describe, expect, it } from 'vitest';

import { adaptWalletModule } from '../src/swap/live-wallet.js';
import { testSigner } from './swap-fixtures.js';

describe('the live wallet adapter', () => {
  it('derives the seed of the first "start swap" signature, and the deposit address from core', async () => {
    const live = adaptWalletModule(Wallet, STAGENET);
    expect(live.kind).toBe('live');
    const signer = testSigner();
    const salt = `0x${'5a'.repeat(32)}`;
    const { seed, deterministic } = await live.deriveSwapSeed(signer, salt);
    expect(deterministic).toBe(true);
    expect(signer.prompts).toHaveLength(2);
    const expected = await signer.signTypedData(
      startSwapTypedData({ network: STAGENET.midnightNetworkId, vault: STAGENET.bridge.vaultAddress, salt }),
    );
    expect(seed).toBe(swapSeedFromSignature(expected));
    const coinPk = '6ba8a1ae'.padEnd(64, '0');
    expect(live.depositAddressFor(coinPk)).toBe(swapDepositAddress(STAGENET, coinPk));
  });
});

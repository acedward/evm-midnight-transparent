// @vitest-environment node
// The live adapter (src/swap/live-wallet.ts) over the REAL wallet module: it derives the same seed
// as core's derivation spec, with the network bound, and the deposit address is core's. What P3 wires
// in place of the mock is this object. (Syncing and building need the network: L-WALLET's own tests
// and the P3 end-to-end runs cover them.)

import {
  START_SWAP_PURPOSE_V2,
  STAGENET,
  registryFor,
  startSwapTypedData,
  swapDepositAddress,
  swapSeedFromSignature,
} from '@evm-midnight-transparent/core';
import * as Wallet from '@evm-midnight-transparent/wallet';
import { describe, expect, it } from 'vitest';

import { adaptWalletModule } from '../src/swap/live-wallet.js';
import { WalletModuleUnavailable, createBackends, lazyWalletModule } from '../src/swap/wiring.js';
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
    // Derivation 2 (the warning prompt, P4.2-fix C14): what new swaps sign.
    expect((signer.prompts[0]!.message as { purpose: string }).purpose).toBe(START_SWAP_PURPOSE_V2);
    const expected = await signer.signTypedData(
      startSwapTypedData({
        network: STAGENET.midnightNetworkId,
        vault: STAGENET.bridge.vaultAddress,
        salt,
        derivation: 2,
      }),
    );
    expect(seed).toBe(swapSeedFromSignature(expected));
    const coinPk = '6ba8a1ae'.padEnd(64, '0');
    expect(live.depositAddressFor(coinPk)).toBe(swapDepositAddress(STAGENET, coinPk));
  });
});

describe('the live wiring (P3): the real wallet module, loaded lazily', () => {
  it('loads the module once, on the first asynchronous call, and sets the Buffer global first', async () => {
    let loads = 0;
    let bufferSet = 0;
    const lazy = lazyWalletModule(STAGENET, async () => {
      loads++;
      return {
        ...Wallet,
        ensureBufferGlobal: () => {
          bufferSet++;
          Wallet.ensureBufferGlobal();
        },
      } as typeof Wallet;
    });
    expect(lazy.kind).toBe('live');
    // The deposit address is core's: no load.
    const coinPk = '6ba8a1ae'.padEnd(64, '0');
    expect(lazy.depositAddressFor(coinPk)).toBe(swapDepositAddress(STAGENET, coinPk));
    expect(loads).toBe(0);
    // A synchronous call before any load is refused (it never happens in a swap: build comes first).
    const draft = { tx: 'ab', offerId: '00'.repeat(32), terms: { give: [], receive: [] }, release: async () => {} };
    expect(() => lazy.finalizeTake(draft, 'cd')).toThrow(WalletModuleUnavailable);
    const signer = testSigner();
    const salt = `0x${'5b'.repeat(32)}`;
    const [a, b] = await Promise.all([lazy.deriveSwapSeed(signer, salt), lazy.deriveSwapSeed(signer, salt)]);
    expect(a.seed).toBe(b.seed);
    expect([loads, bufferSet]).toEqual([1, 1]);
    await lazy.preload();
    expect(loads).toBe(1);
  });

  it('a failed load is reported, and retried by the next call', async () => {
    let n = 0;
    const lazy = lazyWalletModule(STAGENET, async () => {
      if (n++ === 0) throw new Error('network error while fetching the WASM');
      return Wallet;
    });
    await expect(lazy.preload()).rejects.toThrow(/could not be loaded \(network error/);
    await expect(lazy.preload()).resolves.toBeUndefined();
    expect(n).toBe(2);
  });

  it('createBackends without a mock block runs the live module and the real sponsor client', async () => {
    const b = await createBackends(
      { network: STAGENET, sponsorUrl: 'http://127.0.0.1:1/sponsor' },
      registryFor('stagenet'),
    );
    expect(b.wallet.kind).toBe('live');
    expect(b.mock).toBeNull();
    expect(b.sponsor).not.toBeNull();
    b.stop();
  });
});

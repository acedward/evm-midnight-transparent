import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { describe, expect, it, vi } from 'vitest';

import { STAGENET, UNDEPLOYED, swapDepositAddress, swapSeedFromSignature } from '@evm-midnight-transparent/core';

import {
  TempWalletError,
  createTempWallet,
  deriveSwapSeed,
  eip1193SwapSigner,
  temporaryWalletKeys,
  type OpenedShieldedWallet,
  type SwapSigner,
} from '../src/index.js';
import { internalsOf } from '../src/temp-wallet.js';

import { TEST_SEED_A, WSTKA, WUSDC, walletWithCoins } from './helpers.js';

// core's PUBLIC start-swap test vector (packages/core/test/swap-key.test.ts): a signer whose key is
// keccak256 of a label, the stagenet vault, salt keccak256("salt 1"), and a second valid signature
// made with RFC 6979 extra entropy (what a non-deterministic signer returns).
const EVM = new Wallet(keccak256(toUtf8Bytes('evm-midnight-transparent: start-swap test vector 1')));
const OTHER = new Wallet(keccak256(toUtf8Bytes('evm-midnight-transparent: another signer')));
const SALT = keccak256(toUtf8Bytes('salt 1'));
const VECTOR = {
  address: '0x2Ba3671726ba5349879211f2111564bE7ECb716D',
  signature:
    '0x1295dffd4ece9492bfcae263d85053e00a1f7de5896524ae7cca9e51e6d00c800dac9f4f7f0fb4eaf30e0bf53cb7984b12d25f72a5d68e9f8751214bf6ffcaf71c',
  seed: '9d3a761d3aeeb6dc5a6a565b4c036d809613daea7b294509fee2225555c4e3d8',
  otherSignature:
    '0x751ce9d84fff861bb00e95399ffa024a04adf4726e8bcc1be134a184a8e171f65d6025a66a02081aedea3d1565ea554792bf16c9f68be70577449ec013b898441b',
};

const localSigner = (w: Wallet): SwapSigner => ({
  address: w.address,
  signTypedData: async (td) => {
    const { EIP712Domain: _domain, ...types } = td.types;
    return w.signTypedData(td.domain, types, td.message);
  },
});

describe('deriveSwapSeed', () => {
  it("signs the profile's start-swap message twice and returns the first signature's seed (core's vector)", async () => {
    const signer = localSigner(EVM);
    const spy = vi.spyOn(signer, 'signTypedData');
    const out = await deriveSwapSeed(signer, SALT);
    expect(spy).toHaveBeenCalledTimes(2);
    const td = spy.mock.calls[0]![0];
    expect(td.message.network).toBe('stagenet');
    expect(td.message.vault).toBe(`0x${STAGENET.bridge.vaultAddress}`);
    expect(td.message.salt).toBe(SALT);
    expect(td.domain.chainId).toBe(11155111);
    expect(out).toEqual({ seed: VECTOR.seed, deterministic: true, signer: VECTOR.address });
    expect(swapSeedFromSignature(VECTOR.signature)).toBe(VECTOR.seed);
  });

  it('reports a non-deterministic signer and keeps the first seed', async () => {
    const answers = [VECTOR.signature, VECTOR.otherSignature];
    const out = await deriveSwapSeed({ address: VECTOR.address, signTypedData: async () => answers.shift()! }, SALT);
    expect(out).toEqual({ seed: VECTOR.seed, deterministic: false, signer: VECTOR.address });
  });

  it('refuses a signature from another account', async () => {
    await expect(deriveSwapSeed({ ...localSigner(OTHER), address: EVM.address }, SALT)).rejects.toThrow(
      /connected account/,
    );
  });

  it('refuses a profile without a vault', async () => {
    await expect(deriveSwapSeed(localSigner(EVM), SALT, { profile: UNDEPLOYED })).rejects.toBeInstanceOf(
      TempWalletError,
    );
  });

  it('asks an EIP-1193 wallet for eth_signTypedData_v4 with the JSON typed data', async () => {
    const request = vi.fn(async ({ params }: { method: string; params?: unknown[] }) => {
      const td = JSON.parse(String(params![1]));
      return localSigner(EVM).signTypedData(td);
    });
    const out = await deriveSwapSeed(eip1193SwapSigner({ request }, EVM.address), SALT);
    expect(out.deterministic).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    const call = request.mock.calls[0]![0];
    expect(call.method).toBe('eth_signTypedData_v4');
    expect(call.params![0]).toBe(EVM.address);
    expect(JSON.parse(String(call.params![1])).types.EIP712Domain).toBeDefined();
  });
});

describe('createTempWallet', () => {
  it('exposes only public keys and addresses, equal to the key derivation and the deposit address', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, []);
    const keys = temporaryWalletKeys(TEST_SEED_A, 'stagenet');
    expect(wallet.coinPk).toBe(keys.coinPublicKey);
    expect(wallet.encPk).toBe(keys.encryptionPublicKey);
    expect(wallet.shieldedAddress).toBe(keys.shieldedAddress);
    expect(wallet.shieldedAddress.length).toBeGreaterThan(90); // why the SDK's bech32 parser refuses it
    expect(wallet.unshieldedAddress).toBe(keys.unshieldedAddress);
    expect(wallet.depositAddress).toBe(swapDepositAddress(STAGENET, keys.coinPublicKey));
    const shown = JSON.stringify(Object.fromEntries(Object.entries(wallet).filter(([, v]) => typeof v !== 'function')));
    expect(shown).not.toContain(TEST_SEED_A);
    expect(Object.keys(wallet)).not.toContain('keys');
    keys.clear();
    await wallet.close();
  });

  it('reads balances and coins from the shielded state', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [
      { colour: WSTKA, value: 104_166_667n },
      { colour: WUSDC, value: 1n },
      { colour: WUSDC, value: 2n },
    ]);
    expect(await wallet.balances()).toEqual({ [WSTKA]: 104_166_667n, [WUSDC]: 3n });
    const coins = await wallet.coins();
    expect(coins.map((c) => [c.colour, c.value]).sort()).toEqual(
      [
        [WSTKA, 104_166_667n],
        [WUSDC, 1n],
        [WUSDC, 2n],
      ].sort(),
    );
    expect(coins.every((c) => /^[0-9a-f]{64}$/.test(c.nonce))).toBe(true);
    await wallet.close();
  });

  it('has no deposit address without a vault', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [], UNDEPLOYED);
    expect(wallet.depositAddress).toBeNull();
    await wallet.close();
  });

  it('close() stops the sync, wipes the keys and makes the wallet unusable', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, []);
    const { keys, opened } = internalsOf(wallet);
    const stop = vi.spyOn(opened, 'stop');
    const clear = vi.spyOn(keys, 'clear');
    await wallet.close();
    await wallet.close();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(wallet.closed).toBe(true);
    expect(() => internalsOf(wallet)).toThrow(TempWalletError);
    await expect(wallet.balances()).rejects.toThrow(/closed/);
  });

  it('sync() resolves once the shielded wallet is strictly caught up, reporting progress', async () => {
    const { Subject } = await import('rxjs');
    const states = new Subject<{
      progress: { isStrictlyComplete(): boolean; appliedIndex: bigint; highestRelevantWalletIndex: bigint };
    }>();
    const st = (applied: number, latest: number) => ({
      progress: {
        isStrictlyComplete: () => applied === latest,
        appliedIndex: BigInt(applied),
        highestRelevantWalletIndex: BigInt(latest),
      },
    });
    const fake = {
      wallet: { state: states },
      waitSynced: vi.fn(),
      balances: async () => ({}),
      onProgress: (cb: (p: unknown) => void) => {
        const sub = states.subscribe((s) =>
          cb({
            synced: s.progress.isStrictlyComplete(),
            appliedIndex: Number(s.progress.appliedIndex),
            latestIndex: Number(s.progress.highestRelevantWalletIndex),
          }),
        );
        return () => sub.unsubscribe();
      },
      stop: vi.fn(async () => undefined),
    } as unknown as OpenedShieldedWallet;
    const wallet = await createTempWallet(TEST_SEED_A, { openWallet: async () => fake });
    const seen: number[] = [];
    const done = wallet.sync((p) => seen.push(p.appliedIndex));
    states.next(st(10, 100));
    states.next(st(60, 100));
    states.next(st(100, 100));
    const { ms } = await done;
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(seen).toEqual([10, 60, 100]);
    await wallet.close();
  });

  it('wipes the keys when the shielded wallet cannot be opened', async () => {
    await expect(
      createTempWallet(TEST_SEED_A, {
        openWallet: async (keys) => {
          (globalThis as { __lwKeys?: unknown }).__lwKeys = keys;
          throw new Error('indexer down');
        },
      }),
    ).rejects.toThrow('indexer down');
    const keys = (globalThis as { __lwKeys?: { shieldedSecretKeys: { coinPublicKey: string } } }).__lwKeys!;
    expect(() => keys.shieldedSecretKeys.coinPublicKey).toThrow();
    delete (globalThis as { __lwKeys?: unknown }).__lwKeys;
  });
});

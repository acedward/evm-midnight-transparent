// Derivation 2 of the swap key (plan 00048 P4.2-fix, audit C14 / F-A11): the same StartSwap message
// with a warning as its purpose, for new swaps. Version 1 is unchanged (./swap-key.test.ts keeps
// its fixed vectors). The public swap id (`publicSwapId`) is tested in ./swap-key.test.ts.

import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  START_SWAP_PURPOSE,
  START_SWAP_PURPOSE_V2,
  SWAP_KEY_DERIVATION_LATEST,
  SwapKeyError,
  deriveSwapSeed,
  recoverStartSwapSigner,
  startSwapDigest,
  startSwapPurpose,
  startSwapTypedData,
  swapSeedFromSignature,
  type StartSwapSigner,
} from '../src/swap-key.js';

// swap-key.test.ts's PUBLIC test signer and version-1 vector.
const TEST_WALLET = new Wallet(keccak256(toUtf8Bytes('evm-midnight-transparent: start-swap test vector 1')));
const ADDRESS = '0x2Ba3671726ba5349879211f2111564bE7ECb716D';
const VAULT = '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637';
const PARAMS = { network: 'stagenet', vault: VAULT, salt: keccak256(toUtf8Bytes('salt 1')) };
const V1 = {
  digest: '0x4850fb865c71cd1e69ff3f35f90391509f8c7be56b83d4815482c7f0b5b6c93a',
  signature:
    '0x1295dffd4ece9492bfcae263d85053e00a1f7de5896524ae7cca9e51e6d00c800dac9f4f7f0fb4eaf30e0bf53cb7984b12d25f72a5d68e9f8751214bf6ffcaf71c',
  seed: '9d3a761d3aeeb6dc5a6a565b4c036d809613daea7b294509fee2225555c4e3d8',
};
// The fixed vector of version 2. It changes only if the spec changes, which changes every new swap's
// key: a failing vector here is a breaking change, never a test to update.
const V2 = {
  digest: '0x0d8b95d5d69fa817c023b4e3fe9f186b6345cffbeaed18002dd8c1f10b3efabf',
  signature:
    '0x29180a6a095bc49d31b7071f0e4e95f3351f1da5e52334782ec4866f48f3e2985698c2b2393051697bbc0504a0aa743fbead814c80fd5e9fcb4a93e8dd78ca0d1b',
  seed: 'a4ccf5b9124011052b553a154f60370ff7afa8463dbeb1c5a6ebd50f61964ce1',
};
const P2 = { ...PARAMS, derivation: 2 as const };

const localSigner =
  (w: Wallet): StartSwapSigner =>
  async (td) => {
    const { EIP712Domain: _domainFields, ...types } = td.types;
    return w.signTypedData(td.domain, types, td.message);
  };

describe('derivation 2: the warning in the prompt (P4.2-fix C14)', () => {
  it('is what new swaps use; its purpose warns where to sign and what the signature gives away', () => {
    expect(SWAP_KEY_DERIVATION_LATEST).toBe(2);
    expect(startSwapPurpose(2)).toBe(START_SWAP_PURPOSE_V2);
    expect(START_SWAP_PURPOSE_V2).toMatch(/WARNING/);
    expect(START_SWAP_PURPOSE_V2).toMatch(/Only sign it in the swap app where you started this swap/);
    expect(START_SWAP_PURPOSE_V2).toMatch(/whoever gets this signature can take the swap's tokens/);
    expect(START_SWAP_PURPOSE_V2).not.toMatch(/sign it again to recover/);
    expect(startSwapTypedData(P2).message.purpose).toBe(START_SWAP_PURPOSE_V2);
    expect(() => startSwapPurpose(3 as never)).toThrow(SwapKeyError);
  });

  it('keeps version 1 byte for byte (the swaps started before, and the gates)', () => {
    expect(startSwapPurpose(1)).toBe(START_SWAP_PURPOSE);
    expect(startSwapDigest(PARAMS)).toBe(V1.digest);
    expect(startSwapDigest({ ...PARAMS, derivation: 1 })).toBe(V1.digest);
    expect(swapSeedFromSignature(V1.signature)).toBe(V1.seed);
  });

  it('matches its fixed vector: another digest, so another seed for the same salt', async () => {
    expect(startSwapDigest(P2)).toBe(V2.digest);
    expect(await localSigner(TEST_WALLET)(startSwapTypedData(P2))).toBe(V2.signature);
    expect(swapSeedFromSignature(V2.signature)).toBe(V2.seed);
    expect(V2.seed).not.toBe(V1.seed);
    expect(recoverStartSwapSigner(P2, V2.signature)).toBe(ADDRESS);
    // A version-1 signature does not recover to the signer under version 2.
    expect(recoverStartSwapSigner(P2, V1.signature)).not.toBe(ADDRESS);
    const out = await deriveSwapSeed(localSigner(TEST_WALLET), P2, ADDRESS);
    expect(out).toEqual({ seedHex: V2.seed, deterministic: true, signer: ADDRESS });
  });
});

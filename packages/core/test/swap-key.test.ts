import { AbiCoder, Signature, TypedDataEncoder, Wallet, concat, keccak256, toUtf8Bytes } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  START_SWAP_PURPOSE,
  SWAP_KEY_DOMAIN_NAME,
  SwapKeyError,
  deriveSwapSeed,
  newSwapSalt,
  normaliseSignature,
  recoverStartSwapSigner,
  startSwapDigest,
  startSwapDomain,
  startSwapMessage,
  startSwapTypedData,
  swapSeedFromSignature,
  type StartSwapSigner,
} from '../src/swap-key.js';
import { STAGENET } from '../src/network.js';

// A PUBLIC test signer: its key is keccak256 of a label, so no key literal sits in the repository.
const TEST_WALLET = new Wallet(keccak256(toUtf8Bytes('evm-midnight-transparent: start-swap test vector 1')));
const VAULT = '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637';
const PARAMS = { network: 'stagenet', vault: VAULT, salt: keccak256(toUtf8Bytes('salt 1')) };

// The fixed vectors (derivation spec version 1). They change only if the spec changes, which
// changes every swap's key: a failing vector here is a breaking change, never a test to update.
const VECTOR = {
  address: '0x2Ba3671726ba5349879211f2111564bE7ECb716D',
  salt: '0x228399432561dda3990e01da138adc54b71597818e6f9240eb78c8cd5d5f6193',
  digest: '0x4850fb865c71cd1e69ff3f35f90391509f8c7be56b83d4815482c7f0b5b6c93a',
  signature:
    '0x1295dffd4ece9492bfcae263d85053e00a1f7de5896524ae7cca9e51e6d00c800dac9f4f7f0fb4eaf30e0bf53cb7984b12d25f72a5d68e9f8751214bf6ffcaf71c',
  seed: '9d3a761d3aeeb6dc5a6a565b4c036d809613daea7b294509fee2225555c4e3d8',
  /** Another valid signature by the same key over the same digest, made with RFC 6979 extra
   *  entropy (keccak256("extra entropy 1")): what a non-deterministic signer returns. */
  otherSignature:
    '0x751ce9d84fff861bb00e95399ffa024a04adf4726e8bcc1be134a184a8e171f65d6025a66a02081aedea3d1565ea554792bf16c9f68be70577449ec013b898441b',
};

const localSigner =
  (w: Wallet): StartSwapSigner =>
  async (td) => {
    const { EIP712Domain: _domainFields, ...types } = td.types;
    return w.signTypedData(td.domain, types, td.message);
  };

describe('the start-swap message', () => {
  it('names the working domain, Sepolia and the stagenet vault', () => {
    expect(SWAP_KEY_DOMAIN_NAME).toBe('EVM Midnight Swap');
    expect(startSwapDomain()).toEqual({ name: 'EVM Midnight Swap', version: '1', chainId: 11155111 });
    expect(STAGENET.bridge.vaultAddress).toBe(VAULT);
    const td = startSwapTypedData(PARAMS);
    expect(td.primaryType).toBe('StartSwap');
    expect(td.message).toEqual({
      purpose: START_SWAP_PURPOSE,
      network: 'stagenet',
      vault: `0x${VAULT}`,
      salt: VECTOR.salt,
    });
    expect(td.types.EIP712Domain.map((f) => f.name)).toEqual(['name', 'version', 'chainId']);
  });

  it('has the pinned digest, computed here by hand from the EIP-712 rules', () => {
    const enc = AbiCoder.defaultAbiCoder();
    const k = (s: string) => keccak256(toUtf8Bytes(s));
    const domainSeparator = keccak256(
      enc.encode(
        ['bytes32', 'bytes32', 'bytes32', 'uint256'],
        [k('EIP712Domain(string name,string version,uint256 chainId)'), k('EVM Midnight Swap'), k('1'), 11155111],
      ),
    );
    const structHash = keccak256(
      enc.encode(
        ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
        [
          k('StartSwap(string purpose,string network,bytes32 vault,bytes32 salt)'),
          k(START_SWAP_PURPOSE),
          k('stagenet'),
          `0x${VAULT}`,
          VECTOR.salt,
        ],
      ),
    );
    const digest = keccak256(concat(['0x1901', domainSeparator, structHash]));
    expect(digest).toBe(VECTOR.digest);
    expect(startSwapDigest(PARAMS)).toBe(VECTOR.digest);
    const { EIP712Domain: _d, ...types } = startSwapTypedData(PARAMS).types;
    expect(TypedDataEncoder.hash(startSwapDomain(), types, startSwapMessage(PARAMS))).toBe(VECTOR.digest);
  });

  it('accepts hex with or without 0x, in any case, and refuses anything else', () => {
    expect(startSwapDigest({ ...PARAMS, vault: `0x${VAULT.toUpperCase()}` })).toBe(VECTOR.digest);
    expect(() => startSwapMessage({ ...PARAMS, vault: VAULT.slice(2) })).toThrow(SwapKeyError);
    expect(() => startSwapMessage({ ...PARAMS, salt: 'zz' })).toThrow(SwapKeyError);
    expect(() => startSwapMessage({ ...PARAMS, network: 'Stage Net' })).toThrow(SwapKeyError);
  });

  it('binds every field: another salt, vault, network or chain is another digest', () => {
    const other = keccak256(toUtf8Bytes('salt 2'));
    const digests = new Set([
      startSwapDigest(PARAMS),
      startSwapDigest({ ...PARAMS, salt: other }),
      startSwapDigest({ ...PARAMS, vault: other }),
      startSwapDigest({ ...PARAMS, network: 'preprod' }),
      startSwapDigest({ ...PARAMS, chainId: 1 }),
    ]);
    expect(digests.size).toBe(5);
  });
});

describe('the seed', () => {
  it('matches the fixed vector: the test key signs deterministically', async () => {
    expect(TEST_WALLET.address).toBe(VECTOR.address);
    const sig = await localSigner(TEST_WALLET)(startSwapTypedData(PARAMS));
    expect(sig).toBe(VECTOR.signature);
    expect(swapSeedFromSignature(sig)).toBe(VECTOR.seed);
    expect(VECTOR.seed).toBe(keccak256(VECTOR.signature).slice(2));
    expect(recoverStartSwapSigner(PARAMS, sig)).toBe(VECTOR.address);
  });

  it('normalises v = 0/1 to 27/28, so both encodings give one seed', () => {
    const s = Signature.from(VECTOR.signature);
    const raw = concat([s.r, s.s, s.v === 27 ? '0x00' : '0x01']);
    expect(swapSeedFromSignature(raw)).toBe(VECTOR.seed);
    expect(normaliseSignature(raw)[64]).toBe(s.v);
  });

  it('refuses malformed signatures', () => {
    expect(() => swapSeedFromSignature('0x1234')).toThrow(SwapKeyError);
    expect(() => swapSeedFromSignature('nothex')).toThrow(SwapKeyError);
    expect(() => swapSeedFromSignature(`${VECTOR.signature.slice(0, -2)}05`)).toThrow(SwapKeyError);
  });
});

describe('sign twice (Q4)', () => {
  it('a deterministic signer: recoverable, the seed of the fixed vector, two prompts', async () => {
    let prompts = 0;
    const sign: StartSwapSigner = async (td) => {
      prompts += 1;
      return localSigner(TEST_WALLET)(td);
    };
    const out = await deriveSwapSeed(sign, PARAMS, VECTOR.address.toLowerCase());
    expect(prompts).toBe(2);
    expect(out).toEqual({ seedHex: VECTOR.seed, deterministic: true, signer: VECTOR.address });
  });

  it('a non-deterministic signer: the FIRST signature is kept, flagged not recoverable', async () => {
    expect(recoverStartSwapSigner(PARAMS, VECTOR.otherSignature)).toBe(VECTOR.address);
    const answers = [VECTOR.signature, VECTOR.otherSignature];
    const out = await deriveSwapSeed(async () => answers.shift()!, PARAMS);
    expect(out.deterministic).toBe(false);
    expect(out.seedHex).toBe(VECTOR.seed);
    expect(out.signer).toBe(VECTOR.address);
    const reversed = [VECTOR.otherSignature, VECTOR.signature];
    const out2 = await deriveSwapSeed(async () => reversed.shift()!, PARAMS);
    expect(out2.seedHex).toBe(keccak256(VECTOR.otherSignature).slice(2));
    expect(out2.deterministic).toBe(false);
  });

  it('refuses a signature from another account, or two different signers', async () => {
    const other = new Wallet(keccak256(toUtf8Bytes('evm-midnight-transparent: another test signer')));
    await expect(deriveSwapSeed(localSigner(other), PARAMS, VECTOR.address)).rejects.toThrow(
      'not from the connected account',
    );
    const both = [localSigner(TEST_WALLET), localSigner(other)];
    await expect(deriveSwapSeed((td) => both.shift()!(td), PARAMS)).rejects.toThrow('different signers');
  });
});

describe('the salt', () => {
  it('is 32 fresh random bytes', () => {
    const a = newSwapSalt();
    const b = newSwapSalt();
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(newSwapSalt((buf) => buf.fill(7))).toBe(`0x${'07'.repeat(32)}`);
  });
});

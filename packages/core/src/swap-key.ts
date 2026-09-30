// The temporary Midnight wallet's seed, derived from the user's EVM wallet (spec FR-003, Q4 A).
//
// Every swap gets its own Midnight wallet. Nothing secret is stored: the user's EVM wallet signs
// one EIP-712 "start swap" message, and the seed is the keccak256 of that signature. Signing the
// same message again (same salt) on any device gives the same seed, which is how a swap whose tab
// closed is recovered, as long as the signer is deterministic (RFC 6979: MetaMask, Phantom and
// ethers.js sign byte-identically; AA 00025's spike). The app asks for the signature TWICE and
// compares the two: equal means recoverable; different means a non-deterministic signer, and the
// first signature's seed is kept for this session and swap only, with a warning (Q4's resolution).
//
// THE DERIVATION SPEC (version 1):
//
//   domain   { name: SWAP_KEY_DOMAIN_NAME, version: "1", chainId: 11155111 (Sepolia) }
//   type     StartSwap { purpose: string, network: string, vault: bytes32, salt: bytes32 }
//   message  purpose = START_SWAP_PURPOSE (fixed text),
//            network = the Midnight network ("stagenet"),
//            vault   = the bridge vault's Midnight contract address (32 bytes),
//            salt    = 32 random bytes, new for every swap and kept in the swap record (public)
//   sig      the 65-byte r ‖ s ‖ v the wallet returns; v is normalised to 27/28
//   seed     keccak256(sig), 32 bytes
//
// The seed then derives the Midnight keys the standard HD way (account 0, key 0, roles Zswap,
// NightExternal and Dust; `@evm-midnight-transparent/wallet` `temporaryWalletKeys`).
//
// The seed is a SECRET: the caller keeps it in session memory only. It is never written to local
// storage, logged, or sent anywhere except to our own proof server as part of a proof (Q3 A).
// The signature is equally secret (it IS the seed's preimage), so it is never stored either.
//
// Binding the vault and the network into the message keeps a stagenet swap's key different from
// any other deployment's; binding the chain id makes the wallet refuse to sign on another chain.
//
// VERSION 2 (P4.2-fix C14, the audit's F-A11): the same message with another `purpose`, a warning
// (START_SWAP_PURPOSE_V2): EIP-712 cannot bind the site that asks, and whoever holds the signature
// holds the swap's funds, so the prompt itself says where to sign it and what it gives away. New
// swaps use version 2; version 1 stays for the swaps started before (their records say which), and
// the gates' re-derivations. The salt is no longer the swap's public id either: the sponsor, the
// page's URL and every log see `swapIdFromSalt(salt)` = keccak256("evm-midnight-swap/id" ‖ salt),
// and the salt stays in the browser's own record (Resume needs it to ask for the same signature).

import {
  TypedDataEncoder,
  concat,
  getAddress,
  getBytes,
  hexlify,
  keccak256,
  toUtf8Bytes,
  verifyTypedData,
} from 'ethers';

import { bytesToHex } from './hex.js';
import { SEPOLIA_CHAIN_ID } from './network.js';

/** The EIP-712 domain name wallets show when the user signs "start swap". The working name
 *  (questions file, Q10): changing it changes every swap's key, so fix it before launch. */
export const SWAP_KEY_DOMAIN_NAME = 'EVM Midnight Swap';
export const SWAP_KEY_DOMAIN_VERSION = '1';
export const START_SWAP_PRIMARY_TYPE = 'StartSwap';
/** The derivation spec's version 1 (this file's header): the swaps started before P4.2-fix. */
export const SWAP_KEY_DERIVATION_VERSION = 1;
/** The version new swaps use (the warning purpose, P4.2-fix C14). */
export const SWAP_KEY_DERIVATION_LATEST = 2;
export type SwapKeyDerivation = 1 | 2;

/** What the user reads in the wallet's signing prompt (version 1). Part of the key: never edit it. */
export const START_SWAP_PURPOSE =
  "Start a swap. This signature creates the swap's temporary Midnight wallet; sign it again to recover the swap.";

/** Version 2's purpose: a warning in the prompt itself. Part of the key: never edit it. */
export const START_SWAP_PURPOSE_V2 =
  "Start or resume a swap. WARNING: this signature is the key to the swap's temporary Midnight wallet and the tokens in it. Only sign it in the swap app where you started this swap, never on another site: whoever gets this signature can take the swap's tokens.";

/** The purpose text of a derivation version. */
export function startSwapPurpose(derivation: SwapKeyDerivation = SWAP_KEY_DERIVATION_VERSION): string {
  if (derivation === 1) return START_SWAP_PURPOSE;
  if (derivation === 2) return START_SWAP_PURPOSE_V2;
  throw new SwapKeyError('unknown derivation version');
}

/** The tag of the public swap id (P4.2-fix C14). */
export const SWAP_ID_TAG = 'evm-midnight-swap/id';

export const START_SWAP_TYPES = {
  [START_SWAP_PRIMARY_TYPE]: [
    { name: 'purpose', type: 'string' },
    { name: 'network', type: 'string' },
    { name: 'vault', type: 'bytes32' },
    { name: 'salt', type: 'bytes32' },
  ],
};

const EIP712_DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
];

export class SwapKeyError extends Error {
  override name = 'SwapKeyError';
}

export interface StartSwapParams {
  /** The Midnight network, e.g. "stagenet". */
  network: string;
  /** The vault's Midnight contract address (64 hex, optional 0x). */
  vault: string;
  /** The swap's salt (64 hex, optional 0x). */
  salt: string;
  chainId?: number;
  /** The derivation version (default 1; new swaps use SWAP_KEY_DERIVATION_LATEST). */
  derivation?: SwapKeyDerivation;
}

export interface StartSwapMessage {
  purpose: string;
  network: string;
  vault: string;
  salt: string;
}

const hex32 = (label: string, value: string): string => {
  const h = String(value ?? '')
    .replace(/^0x/i, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(h)) throw new SwapKeyError(`the ${label} must be 32 bytes of hex`);
  return `0x${h}`;
};

export function startSwapDomain(chainId: number = SEPOLIA_CHAIN_ID) {
  return { name: SWAP_KEY_DOMAIN_NAME, version: SWAP_KEY_DOMAIN_VERSION, chainId };
}

export function startSwapMessage(p: StartSwapParams): StartSwapMessage {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(p.network)) throw new SwapKeyError('the network name is not valid');
  return {
    purpose: startSwapPurpose(p.derivation),
    network: p.network,
    vault: hex32('vault', p.vault),
    salt: hex32('salt', p.salt),
  };
}

/** The exact JSON for `eth_signTypedData_v4` (EIP712Domain included, as the RPC requires). */
export function startSwapTypedData(p: StartSwapParams) {
  return {
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, ...START_SWAP_TYPES },
    primaryType: START_SWAP_PRIMARY_TYPE,
    domain: startSwapDomain(p.chainId),
    message: startSwapMessage(p),
  };
}

/** The EIP-712 digest the wallet signs. */
export function startSwapDigest(p: StartSwapParams): string {
  return TypedDataEncoder.hash(startSwapDomain(p.chainId), START_SWAP_TYPES, startSwapMessage(p));
}

/** The EVM address that signed, so the app can check it is the connected account. */
export function recoverStartSwapSigner(p: StartSwapParams, signature: string): string {
  return getAddress(verifyTypedData(startSwapDomain(p.chainId), START_SWAP_TYPES, startSwapMessage(p), signature));
}

/** The swap's PUBLIC id: keccak256(utf8(SWAP_ID_TAG) ‖ the salt's 32 bytes), 0x + 64 lowercase hex.
 *  What the sponsor, URLs and logs see; the salt itself stays in the browser (P4.2-fix C14). */
export function swapIdFromSalt(salt: string): string {
  return keccak256(concat([toUtf8Bytes(SWAP_ID_TAG), getBytes(hex32('salt', salt))])).toLowerCase();
}

/** A new swap's salt: 32 bytes from the platform's CSPRNG, 0x-prefixed hex. */
export function newSwapSalt(random: (b: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return `0x${bytesToHex(random(new Uint8Array(32)))}`;
}

/** The 65 signature bytes r ‖ s ‖ v, with v normalised to 27/28 (some signers return 0/1). */
export function normaliseSignature(signature: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = getBytes(signature);
  } catch {
    throw new SwapKeyError('the signature is not hex');
  }
  if (bytes.length !== 65) throw new SwapKeyError('the signature must be 65 bytes');
  const out = Uint8Array.from(bytes);
  const v = out[64]!;
  if (v === 0 || v === 1) out[64] = v + 27;
  else if (v !== 27 && v !== 28) throw new SwapKeyError('the signature has an invalid recovery byte');
  return out;
}

/** seed = keccak256(signature): 64 lowercase hex, no 0x. SECRET. */
export function swapSeedFromSignature(signature: string): string {
  return keccak256(normaliseSignature(signature)).slice(2);
}

/** Signs typed data: `eth_signTypedData_v4` in the app, a local key in tests and gates. */
export type StartSwapSigner = (typedData: ReturnType<typeof startSwapTypedData>) => Promise<string>;

export interface DerivedSwapSeed {
  /** SECRET: session memory only. 64 hex, no 0x. */
  seedHex: string;
  /** True when both signatures were identical: the swap can be recovered by signing again. */
  deterministic: boolean;
  /** The EVM address that signed (both signatures). */
  signer: string;
}

/**
 * Ask for the "start swap" signature twice and derive the seed from the first (Q4's resolution).
 * Throws if either signature does not recover to `expectedSigner` (when given) or if the two
 * recover to different addresses. The signatures themselves are not returned: they are secret.
 */
export async function deriveSwapSeed(
  sign: StartSwapSigner,
  p: StartSwapParams,
  expectedSigner?: string,
): Promise<DerivedSwapSeed> {
  const typedData = startSwapTypedData(p);
  const first = hexlify(normaliseSignature(await sign(typedData)));
  const second = hexlify(normaliseSignature(await sign(typedData)));
  const signer = recoverStartSwapSigner(p, first);
  if (recoverStartSwapSigner(p, second) !== signer) throw new SwapKeyError('the two signatures have different signers');
  if (expectedSigner !== undefined && getAddress(expectedSigner) !== signer) {
    throw new SwapKeyError('the signature is not from the connected account');
  }
  return { seedHex: swapSeedFromSignature(first), deterministic: first === second, signer };
}

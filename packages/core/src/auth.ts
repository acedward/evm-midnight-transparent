// The sponsor's action authorisation: EIP-712 typed data that the user's EVM wallet signs to ask
// the sponsor service to spend its DUST on one of the swap's bridge legs (spec US3, FR-005).
//
// Copied from MN Bank's relay authorisation (acedward/passport-evm-dapp @ 911647b,
// packages/core/src/auth.ts) with its account field replaced by the swap's.
//
// A `SponsorAction` binds, in one signature:
//   - the ACTION (for example "bridge-deposit") and the request body (`payloadHash`, keccak256 of
//     the canonical JSON of the payload), so a signature cannot be reused with other arguments;
//   - the Midnight NETWORK and the SWAP the action is for (32 bytes; zero for none);
//   - the OWNER, the EVM address that must recover from the signature;
//   - a sponsor-issued NONCE, single use: the sponsor remembers every nonce it issued, forgets a
//     nonce the moment it is used, and forgets all of them on restart, so a signature can be
//     accepted at most once, ever;
//   - an EXPIRY (unix seconds); the sponsor also caps how far ahead it may be.
//
// The domain names the sponsor and Sepolia's chain id; wallets check that the connected chain
// matches, which the app switches to first.
//
// TODO(L-SPONSOR): the action list, what identifies a swap (for example the temporary wallet's
// coin public key) and each action's body are the sponsor lane's to settle; the names below are
// placeholders with the verification machinery around them.

import { TypedDataEncoder, getAddress, keccak256, toUtf8Bytes, verifyTypedData } from 'ethers';
import { z } from 'zod';

import { SEPOLIA_CHAIN_ID } from './network.js';

export const SPONSOR_DOMAIN_NAME = 'EVM Midnight Swap Sponsor';
export const SPONSOR_DOMAIN_VERSION = '1';
export const SPONSOR_PRIMARY_TYPE = 'SponsorAction';

/** Every action the sponsor knows (placeholders until L-SPONSOR; see the header). */
export const SPONSOR_ACTIONS = ['swap-open', 'bridge-deposit', 'bridge-withdraw', 'bridge-resume', 'prove'] as const;
export type SponsorActionName = (typeof SPONSOR_ACTIONS)[number];

export const SPONSOR_ACTION_FIELDS = [
  { name: 'action', type: 'string' },
  { name: 'network', type: 'string' },
  { name: 'owner', type: 'address' },
  { name: 'swap', type: 'bytes32' },
  { name: 'payloadHash', type: 'bytes32' },
  { name: 'nonce', type: 'bytes32' },
  { name: 'expiry', type: 'uint64' },
] as const;

export const SPONSOR_ACTION_TYPES = { [SPONSOR_PRIMARY_TYPE]: SPONSOR_ACTION_FIELDS.map((f) => ({ ...f })) };

const EIP712_DOMAIN_FIELDS = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
];

/** The message as it travels in JSON: every value a string. */
export const SponsorActionMessageSchema = z.object({
  action: z.enum(SPONSOR_ACTIONS),
  network: z.string().min(1).max(32),
  owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  swap: z.string().regex(/^0x[0-9a-f]{64}$/),
  payloadHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  expiry: z.string().regex(/^[0-9]{1,20}$/),
});
export type SponsorActionMessage = z.infer<typeof SponsorActionMessageSchema>;

export const SignedSponsorActionSchema = z.object({
  message: SponsorActionMessageSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export type SignedSponsorAction = z.infer<typeof SignedSponsorActionSchema>;

/** `swap` for actions that are not about one swap. */
export const NO_SWAP = `0x${'0'.repeat(64)}`;

export function sponsorDomain(chainId: number = SEPOLIA_CHAIN_ID) {
  return { name: SPONSOR_DOMAIN_NAME, version: SPONSOR_DOMAIN_VERSION, chainId };
}

// ── Canonical JSON and the payload hash ──────────────────────────────────────

export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}

/**
 * A deterministic JSON rendering: object keys sorted, no whitespace, bigints as decimal
 * strings. Only plain JSON values (and bigints) are allowed: no undefined, functions, NaN,
 * byte arrays or class instances, so the browser and the sponsor always hash the same bytes.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'bigint':
      return JSON.stringify(value.toString(10));
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError('only plain objects can be hashed (encode bytes as hex strings)');
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`cannot hash a ${typeof value}`);
  }
}

/** keccak256 of the payload's canonical JSON, 0x-prefixed lowercase hex. */
export function payloadHash(payload: unknown): string {
  return keccak256(toUtf8Bytes(canonicalJson(payload)));
}

// ── Building and signing ─────────────────────────────────────────────────────

export interface SponsorActionInput {
  action: SponsorActionName;
  network: string;
  owner: string;
  /** The swap (64 hex, with or without 0x); omit for none. */
  swap?: string;
  payload: unknown;
  /** Sponsor-issued nonce (0x + 64 hex). */
  nonce: string;
  /** Unix seconds. */
  expiry: number | bigint;
}

export function buildSponsorActionMessage(input: SponsorActionInput): SponsorActionMessage {
  const swap = input.swap === undefined ? NO_SWAP : `0x${input.swap.replace(/^0x/, '').toLowerCase()}`;
  return SponsorActionMessageSchema.parse({
    action: input.action,
    network: input.network,
    owner: getAddress(input.owner),
    swap,
    payloadHash: payloadHash(input.payload),
    nonce: input.nonce.toLowerCase(),
    expiry: BigInt(input.expiry).toString(10),
  });
}

/** The exact JSON for `eth_signTypedData_v4` (EIP712Domain included, as the RPC requires). */
export function sponsorActionTypedData(message: SponsorActionMessage, chainId: number = SEPOLIA_CHAIN_ID) {
  return {
    types: { EIP712Domain: EIP712_DOMAIN_FIELDS, ...SPONSOR_ACTION_TYPES },
    primaryType: SPONSOR_PRIMARY_TYPE,
    domain: sponsorDomain(chainId),
    message,
  };
}

/** The EIP-712 digest the wallet signs. */
export function sponsorActionDigest(message: SponsorActionMessage, chainId: number = SEPOLIA_CHAIN_ID): string {
  return TypedDataEncoder.hash(sponsorDomain(chainId), SPONSOR_ACTION_TYPES, message);
}

/** The address that signed `message`, or throws on a malformed signature. */
export function recoverSponsorActionSigner(
  message: SponsorActionMessage,
  signature: string,
  chainId: number = SEPOLIA_CHAIN_ID,
): string {
  return verifyTypedData(sponsorDomain(chainId), SPONSOR_ACTION_TYPES, message, signature);
}

// ── Verification (the sponsor side) ────────────────────────────────────────────

export type AuthFailureCode =
  | 'malformed'
  | 'wrong-action'
  | 'wrong-network'
  | 'wrong-swap'
  | 'payload-mismatch'
  | 'expired'
  | 'expiry-too-far'
  | 'bad-signature'
  | 'wrong-signer'
  | 'unknown-nonce'
  | 'replayed';

export type AuthResult =
  { ok: true; signer: string; message: SponsorActionMessage } | { ok: false; code: AuthFailureCode; reason: string };

export interface VerifySponsorActionOptions {
  expectedAction: SponsorActionName;
  network: string;
  chainId?: number;
  /** The swap the route acts on (64 hex, optional 0x), or undefined for none. */
  expectedSwap?: string;
  payload: unknown;
  /** Unix seconds; defaults to the wall clock. */
  now?: number;
  /** The furthest an expiry may be in the future, in seconds. */
  maxTtlSeconds: number;
  /**
   * Consume the nonce: returns 'ok' if the sponsor issued it and it was unused (and marks it
   * used), 'unknown' if the sponsor never issued it (or forgot it on restart), 'used' if it was
   * already consumed. Called only after every other check passed.
   */
  consumeNonce(nonce: string, owner: string): 'ok' | 'unknown' | 'used';
}

const fail = (code: AuthFailureCode, reason: string): AuthResult => ({ ok: false, code, reason });

/**
 * What a signed sponsor action binds, WITHOUT its expiry and nonce: the action, network, swap and
 * the exact payload, signed by the owner. An executor uses it to check again, when a queued job's
 * turn comes, an envelope the route already verified in full (its nonce is spent, and it may have
 * expired while the job waited).
 */
export function checkSponsorActionBinding(
  signed: unknown,
  options: Pick<VerifySponsorActionOptions, 'expectedAction' | 'network' | 'chainId' | 'expectedSwap' | 'payload'>,
): AuthResult {
  const parsed = SignedSponsorActionSchema.safeParse(signed);
  if (!parsed.success) return fail('malformed', 'the authorisation is missing or malformed');
  const { message, signature } = parsed.data;
  if (message.action !== options.expectedAction)
    return fail('wrong-action', `signed for "${message.action}", not "${options.expectedAction}"`);
  if (message.network !== options.network) return fail('wrong-network', `signed for network "${message.network}"`);
  const expectedSwap =
    options.expectedSwap === undefined ? NO_SWAP : `0x${options.expectedSwap.replace(/^0x/, '').toLowerCase()}`;
  if (message.swap !== expectedSwap) return fail('wrong-swap', 'signed for another swap');
  let hash: string;
  try {
    hash = payloadHash(options.payload);
  } catch {
    return fail('malformed', 'the payload cannot be hashed');
  }
  if (message.payloadHash !== hash) return fail('payload-mismatch', 'the signature does not cover this request body');
  let signer: string;
  try {
    signer = recoverSponsorActionSigner(message, signature, options.chainId);
  } catch {
    return fail('bad-signature', 'the signature is not valid');
  }
  if (signer !== getAddress(message.owner)) return fail('wrong-signer', 'the signature is not from the owner');
  return { ok: true, signer, message };
}

/** Check a signed sponsor action against the route it arrived on. Pure except `consumeNonce`. */
export function verifySponsorAction(signed: unknown, options: VerifySponsorActionOptions): AuthResult {
  const parsed = SignedSponsorActionSchema.safeParse(signed);
  if (!parsed.success) return fail('malformed', 'the authorisation is missing or malformed');
  const { message, signature } = parsed.data;
  if (message.action !== options.expectedAction)
    return fail('wrong-action', `signed for "${message.action}", not "${options.expectedAction}"`);
  if (message.network !== options.network) return fail('wrong-network', `signed for network "${message.network}"`);
  const expectedSwap =
    options.expectedSwap === undefined ? NO_SWAP : `0x${options.expectedSwap.replace(/^0x/, '').toLowerCase()}`;
  if (message.swap !== expectedSwap) return fail('wrong-swap', 'signed for another swap');
  let hash: string;
  try {
    hash = payloadHash(options.payload);
  } catch {
    return fail('malformed', 'the payload cannot be hashed');
  }
  if (message.payloadHash !== hash) return fail('payload-mismatch', 'the signature does not cover this request body');
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const expiry = Number(message.expiry);
  if (!Number.isSafeInteger(expiry) || expiry <= now) return fail('expired', 'the authorisation has expired');
  if (expiry > now + options.maxTtlSeconds)
    return fail('expiry-too-far', `expiry is more than ${options.maxTtlSeconds} s ahead`);
  let signer: string;
  try {
    signer = recoverSponsorActionSigner(message, signature, options.chainId);
  } catch {
    return fail('bad-signature', 'the signature is not valid');
  }
  if (signer !== getAddress(message.owner)) return fail('wrong-signer', 'the signature is not from the owner');
  const nonce = options.consumeNonce(message.nonce, signer);
  if (nonce === 'unknown')
    return fail('unknown-nonce', 'the sponsor did not issue this nonce (or has restarted); ask for a new one');
  if (nonce === 'used') return fail('replayed', 'this authorisation was already used');
  return { ok: true, signer, message };
}

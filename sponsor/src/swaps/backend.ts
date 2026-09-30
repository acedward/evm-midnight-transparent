// What the swap service needs from the outside world, as interfaces: Sepolia reads, the vault's
// bridge legs (paid by the sponsor), the relayer loop, the rebuild of a `startWithdraw`, proofs,
// and the exchange's offers. The service (./service.ts) holds every rule; it talks only to these,
// so its tests run against fakes (sponsor/test/fakes.ts) and the live implementation
// (../bridge/live-backend.ts) only performs. Modelled on MN Bank's relay
// (acedward/passport-evm-dapp @ 911647b, relay/src/bridge/backend.ts).

import type { EvmGasPolicy, KernelOfferStatus, OfferDetail } from '@evm-midnight-transparent/core';

import type { CallSummary } from '../validate/summary.js';
import type { AttestedKind } from './model.js';

/** Sepolia, read-only. */
export interface EvmReader {
  ethBalance(address: string): Promise<bigint>;
  erc20Balance(token: string, holder: string): Promise<bigint>;
  /** The transaction count, as of the latest block or including the mempool. */
  nonce(address: string, tag: 'latest' | 'pending'): Promise<bigint>;
  /** The latest block's base fee per gas. */
  baseFeePerGas(): Promise<bigint>;
}

export type BridgeKind = 'deposit' | 'withdraw';

/** One stage of the relayer loop (../bridge/relay-loop.ts). */
export type RelayProgress =
  | {
      stage: 'signed';
      signedTxHash: string;
      from: string;
      nonce: number;
      afterMs: number;
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
    }
  /** The signed transfer was broadcast and is not mined yet (reported once; it is broadcast again
   *  until it is mined or its nonce is consumed). */
  | { stage: 'pending'; signedTxHash: string; nonce: number; afterMs: number }
  | {
      stage: 'broadcast';
      evmTxHash: string;
      evmBlock: number;
      evmStatus: number | undefined;
      alreadyMined: boolean;
      afterMs: number;
    }
  | { stage: 'not-broadcast'; reason: string; afterMs: number }
  | { stage: 'finalized'; evmBlock: number; finalizedBlock: number; afterMs: number }
  | { stage: 'attested'; kind: AttestedKind; outputOrigin: string; afterMs: number };

/** An attestation that verifies for a request: what a settle (or `abandonDeposit`) takes. */
export interface Attestation {
  kind: AttestedKind;
  /** The attested event in circuit-input form, and the attested output bytes. */
  event: unknown;
  serializedOutput: Uint8Array;
}

export interface RelayOutcome extends Attestation {
  evmTxHash?: string;
  signedTxHash: string;
  signatureAfterMs: number;
  attestationAfterMs: number;
}

/** The time to live of the DUST balancing the sponsor adds to a withdrawal (ms): the merged
 *  transaction cannot be included after it (audit R5, S1). */
export const WITHDRAW_TX_TTL_MS = 60_000;

/** A submission that failed BEFORE the transaction reached the node (the DUST balancing or the
 *  proofs): conclusive, nothing can land (audit R5). Any other submission error leaves the outcome
 *  uncertain until the request id settles it. */
export class NotSubmittedError extends Error {
  override name = 'NotSubmittedError';
}

/** A Midnight transaction the sponsor submitted and saw finalized. */
export interface MidnightTxFacts {
  /** midnight-js's transaction identifier. */
  txId: string;
  /** The transaction hash, when the indexer reports it. */
  txHash: string | null;
  /** `SucceedEntirely`, `FailFallible`, … */
  status: string;
}

export type SettleCircuit = 'completeDeposit' | 'completeWithdraw' | 'refundWithdraw';

/** The arguments of a `startWithdraw` (the circuit's, in order), as the sponsor rebuilds it. */
export interface WithdrawCallArgs {
  evmNonce: bigint;
  gas: EvmGasPolicy;
  erc20: string;
  amount: bigint;
  dest: string;
  /** The coin handed to the vault: this colour and `amount`, with the browser's nonce. */
  colour: string;
  coinNonce: string;
  /** `left(tempCoinPk)`. */
  refundCoinPk: string;
  /** The temporary wallet's public keys (the call is built as the browser builds it). */
  tempCoinPk: string;
  tempEncPk: string;
}

export interface RebuiltWithdraw {
  calls: CallSummary[];
  callsDigest: string;
  /** The coins the call hands to contracts (the vault's): commitment and owner. */
  outputs: { commitment: string; contract: string | null }[];
  /** The request the call creates (read from the call's own next contract state). */
  requestId: string;
}

/** What an open request asks the MPC to sign, as the vault stores it. */
export interface RequestDetail {
  /** The ERC20 the signed transaction calls (0x…, checksum not guaranteed). */
  erc20: string;
  /** The `transfer` amount in its calldata. */
  amount: bigint;
  evmNonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  /** The EIP-1559 tip the signed transaction will carry (audit S3: both fee fields are checked). */
  maxPriorityFeePerGas?: bigint;
}

/** The chain position a read reflects: the indexer's block at the time of the read (audit S1). */
export interface ReadWatermark {
  height: number;
  /** The block's timestamp, ms. */
  timeMs: number;
}

export interface OpenRequests {
  /** The indexer block the requests were read at (the vault state AS OF this block). Absent when the
   *  backend cannot tell: such a read never establishes that a request is absent (audit S1). */
  asOf?: ReadWatermark;
  ids: string[];
  pathOf(requestId: string): string | undefined;
  /** The request's transaction fields (undefined when they cannot be read). */
  detailOf(requestId: string): RequestDetail | undefined;
}

export interface SwapBackend {
  readonly evm: EvmReader;
  readonly vaultAddress: string;
  /** The vault's own EVM account: deposits are swept to it, withdrawals are paid from it. */
  readonly vaultEvmAddress: string;
  readonly singletonAddress: string;
  /** The Sepolia address whose funds the vault mints to `coinPk` (derived offline). */
  depositAddress(coinPk: string): string;
  /** `depositPath(left(coinPk))`, as the vault stores it (64 hex). */
  depositPathHex(coinPk: string): string;
  openRequests(kind: BridgeKind): Promise<OpenRequests>;
  /** `startDeposit` for a wallet recipient, proven and paid by the sponsor. */
  startDeposit(input: {
    recipientCoinPk: string;
    erc20: string;
    amount: bigint;
    gas: EvmGasPolicy;
    evmNonce: bigint;
  }): Promise<MidnightTxFacts & { requestId: string }>;
  /** The relayer loop for one request (resumable: re-running it with the same id is safe). It never
   *  waits without a deadline: it throws once the signature or the attestation is overdue. */
  relay(input: {
    kind: BridgeKind;
    requestId: string;
    expectedSigner: string;
    signatureTimeoutMs: number;
    /** Counted from the signature; the backend's default when absent. */
    attestationTimeoutMs?: number;
    onProgress: (p: RelayProgress) => void;
  }): Promise<RelayOutcome>;
  /** The request's attestation if one already verifies, without waiting or broadcasting. */
  attestation(kind: BridgeKind, requestId: string): Promise<Attestation | null>;
  /** A settle, sealing any coin it mints to the temporary wallet's encryption key. */
  settle(input: {
    circuit: SettleCircuit;
    requestId: string;
    attestation: Attestation;
    recipientCoinPk: string;
    recipientEncPk: string;
  }): Promise<MidnightTxFacts & { minted: boolean }>;
  /** The vault's permissionless `abandonDeposit`, for a sweep attested never-executed. */
  abandonDeposit(input: { requestId: string; attestation: Attestation }): Promise<MidnightTxFacts>;
  /** A digest of the vault's current contract state: it changes whenever the vault's state does
   *  (a request started or settled), so `/prove` can tell a moved vault from a wrong call. */
  vaultStateMark(): Promise<string>;
  /** The sponsor's own build of `startWithdraw(args)` on the vault's CURRENT state (not proven, not
   *  sent): the calls' public transcripts, and the request it would create. */
  rebuildWithdraw(args: WithdrawCallArgs): Promise<RebuiltWithdraw>;
  /** Add DUST to the browser's bound `startWithdraw` (DUST-only balancing, then merge), submit it and
   *  wait until it is final. Throws NotSubmittedError when it failed before reaching the node.
   *  `onExpiry` is told, BEFORE the transaction is handed to the node, the last moment it can be
   *  included (the DUST balancing's time to live, ms; audit S1). */
  submitWithdraw(finalTx: Uint8Array, hooks?: { onExpiry?: (expiresAtMs: number) => void }): Promise<MidnightTxFacts>;
}

/** Proves on the sponsor's proof server, with the sponsor's key directory. */
export interface SwapProver {
  /** `Transaction<signature, pre-proof, pre-binding>` bytes in, `<signature, proof, pre-binding>` out. */
  prove(unproven: Uint8Array): Promise<Uint8Array>;
}

/** The exchange's offers (the kernel client). */
export interface OfferReader {
  offer(offerId: string): Promise<OfferDetail | null>;
  status(offerId: string): Promise<KernelOfferStatus>;
}

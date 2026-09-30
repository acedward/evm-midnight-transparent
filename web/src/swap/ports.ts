// The three things a swap talks to, as the web app consumes them (the plan's "Lane contracts"):
//
//   - the WALLET MODULE (`@evm-midnight-transparent/wallet`, L-WALLET): the swap's temporary Midnight
//     wallet, the take and withdraw builders, and the batcher submission;
//   - the SPONSOR API (`sponsor/`, L-SPONSOR): open a swap, its state machine, the proof proxy and the
//     withdrawal lane (./sponsor-client.ts is the real HTTP client);
//   - the EXCHANGE (the offer-files kernel), read with core's `KernelClient`.
//
// The page is written against these interfaces only. `./wiring.ts` picks the implementations: the
// mocks in ./mock (P2, CI and the Playwright specs) or the live modules (P3).
//
// Secrets: the seed returned by `deriveSwapSeed` is the temporary wallet's key. It lives in the tab's
// memory only (a `SwapSession`), and is never written to a record, logged, or sent anywhere except,
// inside the wallet module, to our own proof server (Q3 A).

import type { BatcherResult, KernelClient } from '@evm-midnight-transparent/core';

import type { SponsorApi } from './sponsor-client.js';

/** EIP-712 typed data as `eth_signTypedData_v4` takes it (EIP712Domain included in `types`). */
export interface TypedData {
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  domain: object;
  message: object;
}

/** The connected EVM account, able to sign typed data. */
export interface TypedDataSigner {
  /** Checksummed address. */
  address: string;
  signTypedData(typedData: TypedData): Promise<string>;
}

/** A hex-encoded transaction (proven or not), as the wallet module and the sponsor exchange them. */
export type TxHex = string;

export interface TempWallet {
  /** The temporary wallet's coin public key: 64 lowercase hex. Public. */
  readonly coinPk: string;
  /** Its encryption public key: 64 lowercase hex. Public. */
  readonly encPk: string;
  /** `mn_shield-addr_<network>1…`, built from the two public keys. */
  readonly shieldedAddress: string;
  /** Catch up with the chain (shielded side only). */
  sync(): Promise<unknown>;
  /** Spendable shielded balances by colour (64 lowercase hex), in base units, as of the last sync. */
  balances(): Promise<Record<string, bigint>>;
  close(): Promise<void>;
}

/** What `withdraw-params` answers and `buildWithdraw` takes (L-SPONSOR 7, L-WALLET 3). */
export interface WithdrawParams {
  kind: 'swap' | 'bridge-back';
  colour: string;
  amount: bigint;
  erc20Address: string;
  dest: string;
  refundRecipient: string;
  gas: { gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; keyVersion: bigint };
  evmNonce: bigint;
}

/** A take, built and unproven: `tx` goes to `/prove`; `release()` gives the booked coin back. */
export interface TakeDraft {
  readonly tx: TxHex;
  /** The kernel's offer id of the SERVED offer: sha256 of its maker transaction's bytes (P4.2-fix C10). */
  readonly offerId: string;
  /** What the taker gives and receives, read from the served offer's own transaction. */
  readonly terms: {
    readonly give: ReadonlyArray<{ colour: string; amount: bigint }>;
    readonly receive: ReadonlyArray<{ colour: string; amount: bigint }>;
  };
  release(): Promise<void>;
}

/** A `startWithdraw`, built and unproven, with `/prove`'s two public hints. */
export interface WithdrawDraft {
  readonly tx: TxHex;
  readonly coinNonce: string;
  readonly evmNonce: bigint;
  release(): Promise<void>;
}

/** The batcher's answer to a take, plus whether the node refused it because the offer was already
 *  taken (239 NullifierAlreadyPresent): the page then shows "Swap is not available". */
export interface SubmitTakeResult extends BatcherResult {
  lostRace: boolean;
}

/**
 * The wallet module as the page calls it: `@evm-midnight-transparent/wallet` with the network profile
 * bound (./live-wallet.ts adapts the real one; ./mock/wallet.ts is the mock).
 *
 *   take:      buildTake → sponsor /prove (take) → finalizeTake → submitTake
 *   withdraw:  sponsor withdraw-params → buildWithdraw → /prove (withdraw, hints) → finalizeWithdraw → /withdraw
 */
export interface WalletModule {
  /** Where this module runs against: shown in the page's mock banner. */
  readonly kind: 'mock' | 'live' | 'unavailable';
  /** Ask for the "start swap" signature TWICE (derivation 2, the warning prompt: P4.2-fix C14); the
   *  seed is the first signature's keccak256 and `deterministic` says whether both were equal (Q4).
   *  SECRET seed: memory only, straight into `createTempWallet`. The salt is local only. */
  deriveSwapSeed(signer: TypedDataSigner, salt: string): Promise<{ seed: string; deterministic: boolean }>;
  createTempWallet(seed: string): Promise<TempWallet>;
  /** The swap's Sepolia deposit address for the temporary wallet's coin key (core). */
  depositAddressFor(coinPk: string): string;
  /** Balance the offer's shielded side: unproven. */
  buildTake(wallet: TempWallet, offerBech32: string): Promise<TakeDraft>;
  /** The proven balancing (from `/prove`) merged into the maker's transaction: the settlement. It
   *  refuses an answer that is not exactly the draft once proofs are erased (P4.2-fix C10). */
  finalizeTake(draft: TakeDraft, provenHex: TxHex): { tx: TxHex };
  /** Submit the settlement to the exchange's batcher, which pays its fee. */
  submitTake(wallet: TempWallet, settlement: { tx: TxHex }): Promise<SubmitTakeResult>;
  /** The vault's `startWithdraw` on its live state, shielded side balanced: unproven. Build it right
   *  before `/prove` (G-BRIDGE flag). */
  buildWithdraw(wallet: TempWallet, params: WithdrawParams): Promise<WithdrawDraft>;
  /** The proven `startWithdraw` (from `/prove`), bound and checked (exactly the draft once proofs are
   *  erased: every call argument and recipient; P4.2-fix C10): what `/withdraw` takes. */
  finalizeWithdraw(draft: WithdrawDraft, provenHex: TxHex): { tx: TxHex };
}

/** The ports a swap uses, and the mock controls when they are mocks. */
export interface SwapBackends {
  kernel: KernelClient;
  sponsor: SponsorApi | null;
  wallet: WalletModule;
  /** Present only in mock mode. */
  mock: { describe: string } | null;
  /** How often the page asks the sponsor for the swap's state, in ms. */
  pollMs: number;
}

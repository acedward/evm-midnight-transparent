// The sponsor's swap API: paths, request and response shapes, shared by the web app, the temporary
// wallet and the sponsor (plan 00048, "Lane contracts": the sponsor API, and L-SPONSOR's answer to
// L-WEB's reading of it). A change here is a change of the wire contract for every side.
//
//   GET  /v1/config                          public configuration (network, vault, tokens, EIP-712 domains)
//   GET  /v1/health                          health (also served at /health for monitors)
//   GET  /v1/auth/nonce                      a single-use nonce for the open-swap signature
//   POST /v1/swaps                           open (or re-open) a swap: ONE EIP-712 SponsorAction signature
//   GET  /v1/swaps/:id                       the swap's state machine                         (bearer)
//   GET  /v1/swaps/:id/withdraw-params       what startWithdraw needs, except the coin         (bearer)
//   POST /v1/swaps/:id/prove                 prove a take or a startWithdraw on the sponsor    (bearer)
//   POST /v1/swaps/:id/withdraw              the proven, bound startWithdraw: DUST, lane, relay (bearer)
//   POST /v1/swaps/:id/take                  the page reports the take's outcome               (bearer)
//
// "bearer" = `Authorization: Bearer <swapToken>`, the random token `POST /v1/swaps` returns. The
// token is a credential: keep it in memory only. Re-opening the swap (same swap id, owner, terms
// and temporary keys, a fresh signature) returns a new token and revokes the old one.
//
// Hex values are lowercase without `0x` (colours, keys, offer ids, request ids, Midnight hashes)
// unless they are EVM values (addresses and Sepolia hashes, `0x…`). Amounts are decimal strings of
// base units. Errors are `{error: {code, message, detail?}}` (./api.ts `ApiError`).

import { z } from 'zod';

import { SignedSponsorActionSchema } from './auth.js';

export const SWAP_PATHS = {
  config: '/v1/config',
  health: '/v1/health',
  nonce: '/v1/auth/nonce',
  swaps: '/v1/swaps',
  swap: (swapId: string) => `/v1/swaps/${swapId}`,
  withdrawParams: (swapId: string) => `/v1/swaps/${swapId}/withdraw-params`,
  prove: (swapId: string) => `/v1/swaps/${swapId}/prove`,
  withdraw: (swapId: string) => `/v1/swaps/${swapId}/withdraw`,
  take: (swapId: string) => `/v1/swaps/${swapId}/take`,
} as const;

/** The action name the open-swap signature carries. */
export const OPEN_SWAP_ACTION = 'open-swap' as const;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'expected 64 lowercase hex characters (no 0x)');
const decimal = z.string().regex(/^[1-9][0-9]{0,38}$/, 'expected a positive decimal integer string');
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address');
/** A swap id in a path or body: the "start swap" salt, 32 bytes, with or without 0x. */
export const SwapIdSchema = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]{64}$/, 'expected a 32-byte swap id')
  .transform((s) => s.replace(/^0x/i, '').toLowerCase());

// ── Open ───────────────────────────────────────────────────────────────────────

export const SwapLegSchema = z.object({ colour: hex64, amount: decimal }).strict();
export type SwapLegWire = z.infer<typeof SwapLegSchema>;

/** What the open-swap signature covers (its `payloadHash` is keccak256 of this object's canonical JSON). */
export const OpenSwapPayloadSchema = z
  .object({
    /** The kernel's offer id. */
    offerId: hex64,
    /** The user's EVM address: it must be the signature's `owner`. */
    evmAddress,
    /** What the user pays: the offer's WANTED leg, bridged in. */
    pay: SwapLegSchema,
    /** What the user receives: the offer's GIVEN leg, bridged out. */
    receive: SwapLegSchema,
    /** The temporary wallet's shielded coin public key (the deposit's recipient). */
    tempCoinPk: hex64,
    /** The temporary wallet's shielded encryption public key (seals the minted coins to it). */
    tempEncPk: hex64,
  })
  .strict();
export type OpenSwapPayload = z.infer<typeof OpenSwapPayloadSchema>;

export const OpenSwapRequestSchema = z
  .object({
    /** The swap id (the "start swap" salt). It must be the signature's `swap`. */
    swap: SwapIdSchema,
    payload: OpenSwapPayloadSchema,
    auth: SignedSponsorActionSchema,
  })
  .strict();
export type OpenSwapRequest = z.input<typeof OpenSwapRequestSchema>;

/** The sweep's EIP-1559 fields, fixed when the swap opens (spec Q5 A): the user sends `ethWei`
 *  (= gasLimit × maxFeePerGas) to the deposit address with the token. Decimal strings. */
export const SweepGasSchema = z.object({
  gasLimit: decimal,
  maxFeePerGas: decimal,
  maxPriorityFeePerGas: decimal,
  ethWei: decimal,
});
export type SweepGas = z.infer<typeof SweepGasSchema>;

// ── The state machine ──────────────────────────────────────────────────────────

/**
 *   awaiting_funds → depositing → minted → taking → taken → withdrawing → done
 *                                    └──────────────────→ bridging_back → done   ("Swap is not available")
 *   a refund (the vault's transfer did not happen) → back to minted; any → failed
 */
export const SWAP_STATES = [
  'awaiting_funds',
  'depositing',
  'minted',
  'taking',
  'taken',
  'withdrawing',
  'bridging_back',
  'done',
  'failed',
] as const;
export type SwapState = (typeof SWAP_STATES)[number];

export const TERMINAL_SWAP_STATES: readonly SwapState[] = ['done', 'failed'];

export const StageSchema = z.object({
  stage: z.string(),
  /** Unix seconds. */
  at: z.number().int(),
  /** Public details only: hashes, ids, heights, amounts. */
  detail: z.record(z.string(), z.string()).optional(),
});
export type StageEntry = z.infer<typeof StageSchema>;

/** The attested outcome of an MPC-signed Sepolia transaction. */
export const ATTESTED_KINDS = ['success', 'returned-false', 'never-executed'] as const;

export const DepositViewSchema = z.object({
  /** waiting-for-funds, funds-seen, starting, started, mpc-signed, evm-broadcast, evm-final,
   *  attested, completing, completed, abandoned (a never-executed sweep; the funds wait for a retry). */
  stage: z.string(),
  stages: z.array(StageSchema),
  requestId: z.string().optional(),
  /** `startDeposit`'s Midnight transaction hash, and midnight-js's identifier. */
  startTx: z.string().optional(),
  startTxId: z.string().optional(),
  /** The MPC-signed sweep on Sepolia. */
  sweepTx: z.string().optional(),
  completeTx: z.string().optional(),
  completeTxId: z.string().optional(),
  attested: z.enum(ATTESTED_KINDS).optional(),
  attempts: z.number().int(),
});
export type DepositView = z.infer<typeof DepositViewSchema>;

export const WITHDRAW_KINDS = ['swap', 'bridge-back'] as const;
export type WithdrawKind = (typeof WITHDRAW_KINDS)[number];

export const WithdrawViewSchema = z.object({
  /** `swap`: the received token to the user; `bridge-back`: the paid token back to the user. */
  kind: z.enum(WITHDRAW_KINDS),
  colour: z.string(),
  amount: z.string(),
  /** queued, starting, started, mpc-signed, evm-broadcast, evm-not-broadcast, evm-final, attested,
   *  completing, completed, refunded, failed. */
  stage: z.string(),
  stages: z.array(StageSchema),
  requestId: z.string().optional(),
  startTx: z.string().optional(),
  startTxId: z.string().optional(),
  /** The vault's MPC-signed ERC20 transfer on Sepolia. */
  sepoliaTx: z.string().optional(),
  completeTx: z.string().optional(),
  completeTxId: z.string().optional(),
  attested: z.enum(ATTESTED_KINDS).optional(),
  /** How many withdrawals of this swap were refunded before this one. */
  refunds: z.number().int(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type WithdrawView = z.infer<typeof WithdrawViewSchema>;

export const SwapLegViewSchema = z.object({
  colour: z.string(),
  amount: z.string(),
  symbol: z.string(),
  erc20Address: z.string(),
  decimals: z.number().int(),
});

export const SwapViewSchema = z.object({
  swapId: z.string(),
  state: z.enum(SWAP_STATES),
  evmAddress: z.string(),
  offerId: z.string(),
  pay: SwapLegViewSchema,
  receive: SwapLegViewSchema,
  tempCoinPk: z.string(),
  depositAddress: z.string(),
  /** The pay token's ERC20 and the exact amount to send to the deposit address. */
  erc20Address: z.string(),
  amount: z.string(),
  sweepGas: SweepGasSchema,
  deposit: DepositViewSchema.nullable(),
  takeTx: z.string().nullable(),
  /** The current (latest) withdrawal. */
  withdraw: WithdrawViewSchema.nullable(),
  /** Every withdrawal attempt, oldest first (refunded ones included). */
  withdrawals: z.array(WithdrawViewSchema),
  /** On `done`. */
  outcome: z.enum(['swapped', 'bridged-back']).optional(),
  /** On `failed`: a stable code, and a sentence for the page. */
  reason: z.string().optional(),
  message: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type SwapView = z.infer<typeof SwapViewSchema>;

export const OpenSwapResponseSchema = z.object({
  swapToken: z.string().min(32),
  depositAddress: z.string(),
  sweepGas: SweepGasSchema,
  erc20Address: z.string(),
  amount: z.string(),
  /** True when this swap id was already open (a resume). */
  resumed: z.boolean(),
  swap: SwapViewSchema,
});
export type OpenSwapResponse = z.infer<typeof OpenSwapResponseSchema>;

// ── Withdrawals ────────────────────────────────────────────────────────────────

/** Everything `startWithdraw` needs except the coin (the browser picks a fresh random coin nonce). */
export const WithdrawParamsSchema = z.object({
  kind: z.enum(WITHDRAW_KINDS),
  colour: hex64,
  amount: decimal,
  erc20Address: evmAddress,
  /** The user's EVM address. */
  dest: evmAddress,
  /** `left(tempCoinPk)`: a refund is minted back to the temporary wallet. */
  refundRecipient: hex64,
  /** The sponsor's gas policy for the vault account's transfer; nothing else is accepted. */
  gas: z.object({ gasLimit: decimal, maxFeePerGas: decimal, maxPriorityFeePerGas: decimal, keyVersion: decimal }),
  /** The vault EVM account's nonce to sign (decimal, may be "0"). */
  evmNonce: z.string().regex(/^[0-9]{1,20}$/),
  vaultAddress: hex64,
});
export type WithdrawParams = z.infer<typeof WithdrawParamsSchema>;

export const PROVE_PURPOSES = ['take', 'withdraw'] as const;
export type ProvePurpose = (typeof PROVE_PURPOSES)[number];

/** Upper bound for a transaction's hex (the sponsor's body limit also applies). */
const txHex = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]+$/, 'expected hex')
  .max(1_500_000)
  .refine((s) => s.replace(/^0x/i, '').length % 2 === 0, 'odd-length hex');

export const ProveRequestSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('take'), tx: txHex }).strict(),
  z
    .object({
      purpose: z.literal('withdraw'),
      tx: txHex,
      /** The nonce of the coin the call hands to the vault (public: it is in the call's arguments). */
      coinNonce: hex64,
      /** The vault account's EVM nonce the call signs (from withdraw-params). */
      evmNonce: z.string().regex(/^[0-9]{1,20}$/),
      /** Which withdrawal this is (from withdraw-params); inferred when absent. */
      kind: z.enum(WITHDRAW_KINDS).optional(),
    })
    .strict(),
]);
export type ProveRequest = z.input<typeof ProveRequestSchema>;

/** `tx`: `Transaction<signature, proof, pre-binding>` hex; the browser binds it. */
export const ProveResponseSchema = z.object({ tx: z.string() });
export type ProveResponse = z.infer<typeof ProveResponseSchema>;

/** `tx`: the bound `Transaction<signature, proof, binding>` hex whose calls this swap's latest
 *  `/prove withdraw` validated. */
export const WithdrawRequestSchema = z.object({ tx: txHex }).strict();
export type WithdrawRequest = z.input<typeof WithdrawRequestSchema>;

export const TakeReportSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('taken'), takeTx: hex64 }).strict(),
  z.object({ outcome: z.literal('not-available') }).strict(),
]);
export type TakeReport = z.input<typeof TakeReportSchema>;

export const SwapResponseSchema = z.object({ swap: SwapViewSchema });
export type SwapResponse = z.infer<typeof SwapResponseSchema>;

// ── Error codes ────────────────────────────────────────────────────────────────

/** The `error.code` values the swap routes answer with, beyond the generic ones (bad-request,
 *  rate-limited, not-found, unauthorised, internal-error). */
export const SWAP_ERRORS = {
  /** 409: the swap is not in a state that allows this call. */
  wrongState: 'wrong-state',
  /** 409: a known swap id with other terms, keys or owner. */
  conflict: 'swap-conflict',
  /** 409: the offer is gone (consumed, expired, cancelled) or not in the book. */
  offerNotAvailable: 'offer-not-available',
  /** 422: the offer's legs are not the request's pay/receive, or not swappable. */
  offerMismatch: 'offer-mismatch',
  /** 422: the transaction is not the one this swap may have proven or paid for (detail says why). */
  invalidTx: 'invalid-tx',
  /** 409: the vault moved since the transaction was built: rebuild and prove again. */
  staleVaultState: 'stale-vault-state',
  /** 409: the EVM nonce is not the vault account's pending nonce: rebuild and prove again. */
  staleEvmNonce: 'stale-evm-nonce',
  /** 409: `/withdraw` without a matching `/prove withdraw`. */
  notProven: 'not-proven',
  /** 409: a withdrawal of this swap is already running. */
  withdrawalInProgress: 'withdrawal-in-progress',
  /** 429: the swap's proof budget is spent. */
  proofBudget: 'proof-budget',
  /** 429: too many open swaps for this EVM address. */
  tooManySwaps: 'too-many-swaps',
  /** 503: the sponsor cannot pay right now, or the bridge / prover is unavailable. */
  sponsorUnavailable: 'sponsor-unavailable',
  sponsorLow: 'sponsor-low',
  bridgeUnavailable: 'bridge-unavailable',
  proverUnavailable: 'prover-unavailable',
} as const;

/** `invalid-tx` details. */
export const INVALID_TX_DETAILS = [
  'not-a-transaction',
  'unshielded',
  'dust',
  'fallible',
  'contract-calls',
  'no-shielded',
  'too-many-coins',
  'wrong-offer',
  'not-balanced',
  'another-colour',
  'wrong-colour',
  'wrong-amount',
  'extra-calls',
  'missing-call',
  'wrong-contract',
  'wrong-entry-point',
  'wrong-call',
  'deploy-or-maintenance',
] as const;
export type InvalidTxDetail = (typeof INVALID_TX_DETAILS)[number];

// ── Public configuration ───────────────────────────────────────────────────────

export const SwapConfigSchema = z.object({
  network: z.string(),
  chainId: z.number().int(),
  sponsorVersion: z.string(),
  appName: z.string(),
  eip712: z.object({
    sponsorDomain: z.object({ name: z.string(), version: z.string(), chainId: z.number().int() }),
    swapKeyDomain: z.object({ name: z.string(), version: z.string(), chainId: z.number().int() }),
  }),
  bridge: z.object({ vaultAddress: z.string(), vaultEvmAddress: z.string(), signetSingleton: z.string() }),
  tokens: z.array(
    z.object({
      symbol: z.string(),
      name: z.string(),
      midnightName: z.string(),
      decimals: z.number().int(),
      sepoliaAddress: z.string(),
      midnightColour: z.string(),
    }),
  ),
  kernelUrl: z.string(),
  batcher: z.object({ url: z.string(), target: z.string() }),
  limits: z.object({
    authMaxTtlSeconds: z.number().int(),
    /** A new swap's offer must expire at least this far ahead. */
    minOfferTtlSeconds: z.number().int(),
    proofsPerSwap: z.number().int(),
  }),
});
export type SwapConfig = z.infer<typeof SwapConfigSchema>;

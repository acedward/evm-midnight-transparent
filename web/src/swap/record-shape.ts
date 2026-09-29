// The swap record: what the page keeps in this browser about one swap, so it can be shown, exported
// and resumed (spec FR-007, US2). It holds NO secret: never the temporary wallet's seed, never a
// signature (the seed's preimage), never the sponsor's swap token (a bearer credential). Resuming
// re-derives the key by signing the swap's "start swap" message again, and re-opens the swap with
// the sponsor for a new token.
//
// Everything here is public: the salt (swap id), the offer, amounts, addresses, the temporary
// wallet's PUBLIC keys, request ids, transaction hashes and states. The shape is strict: Import
// accepts only records this page could have written (./store/record-schemas.ts).

import { z } from 'zod';

/** The record format's version (inside the store's own schema version 1). */
export const SWAP_RECORD_VERSION = 1;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const swapId = z.string().regex(/^0x[0-9a-f]{64}$/);
const decimal = z.string().regex(/^\d{1,78}$/);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
/** A transaction hash or id as a chain, the batcher or the sponsor reported it. */
const txRef = z.string().regex(/^(0x)?[0-9a-fA-F]{8,140}$/);
const ms = z.number().int().nonnegative();
const shortText = z.string().max(64);

const Leg = z
  .object({
    colour: hex64,
    symbol: shortText,
    midnightName: shortText,
    decimals: z.number().int().min(0).max(18),
    amount: decimal,
  })
  .strict();

const Offer = z
  .object({
    offerId: hex64,
    pay: Leg,
    receive: Leg,
    expiresAt: z.string().max(40).nullable(),
  })
  .strict();

const Stage = z.object({ stage: shortText, at: ms }).strict();

const SentTx = z
  .object({ hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), status: z.enum(['sent', 'confirmed', 'failed']) })
  .strict();

export const SWAP_PHASES = [
  /** The sponsor has the swap; the user has not sent the funds yet. */
  'funding',
  /** The funds are at the deposit address; the vault is minting them to the temporary wallet. */
  'bridging-in',
  /** The coin is in the temporary wallet; the take is being built, proven or submitted. */
  'taking',
  /** The offer was gone at take time: "Swap is not available", waiting for Bridge back. */
  'unavailable',
  /** The received token is going back to Sepolia. */
  'bridging-out',
  /** The paid token is going back to Sepolia (Bridge back). */
  'bridging-back',
  'done',
  'failed',
] as const;
export type SwapPhase = (typeof SWAP_PHASES)[number];

export const SwapRecordSchema = z
  .object({
    v: z.literal(SWAP_RECORD_VERSION),
    /** The swap's salt: 32 random bytes, public, the id the sponsor knows the swap by. */
    swapId,
    /** The key derivation spec's version (core swap-key.ts). */
    derivation: z.literal(1),
    network: z.string().regex(/^[a-z0-9-]{1,32}$/),
    vault: hex64,
    evmAddress,
    /** Whether the two "start swap" signatures were equal: only then can the swap be resumed by
     *  signing again (Q4). */
    deterministic: z.boolean(),
    offer: Offer,
    /** The temporary wallet's PUBLIC keys and address. */
    temp: z.object({ coinPk: hex64, encPk: hex64, shieldedAddress: z.string().max(200) }).strict(),
    deposit: z
      .object({
        address: evmAddress,
        erc20Address: evmAddress,
        amount: decimal,
        sweepGas: z.object({ gasLimit: decimal, maxFeePerGas: decimal, ethWei: decimal }).strict(),
      })
      .strict(),
    funding: z.object({ eth: SentTx.optional(), token: SentTx.optional() }).strict(),
    bridgeIn: z
      .object({
        requestId: txRef.optional(),
        stage: shortText.optional(),
        stages: z.array(Stage).max(32).optional(),
        startTx: txRef.optional(),
        sweepTx: txRef.optional(),
        completeTx: txRef.optional(),
      })
      .strict(),
    take: z
      .object({
        tx: txRef.optional(),
        /** The batcher said the take succeeded (set even when it gave no hash): never take twice. */
        landed: z.boolean().optional(),
        attempts: z.number().int().min(0).max(100).optional(),
      })
      .strict(),
    /** 'swap' until the user presses Bridge back. */
    choice: z.enum(['swap', 'bridge-back']),
    bridgeOut: z
      .object({
        colour: hex64.optional(),
        requestId: txRef.optional(),
        stage: shortText.optional(),
        stages: z.array(Stage).max(32).optional(),
        startTx: txRef.optional(),
        sepoliaTx: txRef.optional(),
        completeTx: txRef.optional(),
        /** Withdrawals this page submitted, and how many the sponsor refunded (Q9 A): while
         *  attempts > refunds, one is in flight and the page must not build another. */
        attempts: z.number().int().min(0).max(100).optional(),
        refunds: z.number().int().min(0).max(100).optional(),
        /** Refunded withdrawals' ids and hashes, oldest first (every hash stays on the record). */
        earlier: z
          .array(
            z
              .object({
                requestId: txRef.optional(),
                startTx: txRef.optional(),
                sepoliaTx: txRef.optional(),
                completeTx: txRef.optional(),
              })
              .strict(),
          )
          .max(8)
          .optional(),
      })
      .strict(),
    phase: z.enum(SWAP_PHASES),
    outcome: z.enum(['swapped', 'bridged-back']).optional(),
    /** Why the swap failed or stopped, as shown to the user. */
    error: z.string().max(500).optional(),
    createdAt: ms,
    updatedAt: ms,
  })
  .strict();
export type SwapRecord = z.infer<typeof SwapRecordSchema>;

/** Terminal phases: nothing more will happen. */
export const isFinished = (r: Pick<SwapRecord, 'phase'>) => r.phase === 'done' || r.phase === 'failed';

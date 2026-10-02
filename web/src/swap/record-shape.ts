// The swap record: what the page keeps in this browser about one swap, so it can be shown, exported
// and resumed (spec FR-007, US2). It holds NO secret: never the temporary wallet's seed, never a
// signature (the seed's preimage), never the sponsor's swap token (a bearer credential). Resuming
// re-derives the key by signing the swap's "start swap" message again, and re-opens the swap with
// the sponsor for a new token.
//
// Public: the swap id, the offer, amounts, addresses, the temporary wallet's PUBLIC keys, request ids,
// transaction hashes and states. LOCAL ONLY (P4.2-fix C14): the salt. It is no key, but with it a
// site could show the user the exact "start swap" prompt whose signature is the key, so it never
// leaves this browser (the sponsor, URLs and logs see the swap id = keccak256(tag ‖ salt)); Export
// carries it, because Import → Resume needs it. The shape is strict: Import accepts only records
// this page could have written (./store/record-schemas.ts).
//
// Version 2 (P4.2-fix): `salt` next to the public `swapId`, derivation 2 (the warning prompt), and
// `recoverable` on a failed swap: the sponsor's word, true or false (C5; `false` kept since
// P4.2-fix2 R3). A version-1 record (written before: its id IS its salt, derivation 1) is read as a
// legacy version 2 and still resumes; a failed one without `recoverable` is offered for Resume, and
// the sponsor's answer to the re-open decides.

import { publicSwapId } from '@evm-midnight-transparent/core';
import { z } from 'zod';

/** The record format's version (inside the store's own schema version 1). */
export const SWAP_RECORD_VERSION = 2;

/** The swap's PUBLIC id as the page writes it (0x + 64 hex): core's `publicSwapId(salt)`, the
 *  keccak256 of "evm-midnight-swap/id" and the salt (P4.2-fix C14). */
export const swapIdOf = (salt: string): string => `0x${publicSwapId(salt)}`;

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

const SwapRecordV2 = z
  .object({
    v: z.literal(SWAP_RECORD_VERSION),
    /** The swap's PUBLIC id, the one the sponsor knows it by: `swapIdOf(salt)` (a legacy
     *  derivation-1 record: the salt itself). */
    swapId,
    /** The "start swap" salt: 32 random bytes. LOCAL ONLY: never sent, never in a URL or a log. */
    salt: swapId,
    /** The key derivation spec's version (core swap-key.ts): 2 for new swaps (the warning prompt). */
    derivation: z.union([z.literal(1), z.literal(2)]),
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
    /** A PARTIAL deposit (P4.2-fix3 S2, ./partial.ts): the sponsor reported that a completed vault
     *  request minted less than the pay amount to the temporary wallet. `minted` is what the
     *  temporary wallet received, `remaining` what is still missing (at the deposit address);
     *  `wait` = the user chose "Wait for the rest". Kept after a Bridge back of what arrived, so the
     *  page can say what stayed at the deposit address. */
    partial: z
      .object({ minted: decimal, remaining: decimal, wait: z.literal(true).optional() })
      .strict()
      .optional(),
    /** P4.2-fix4 T1 (./settled-elsewhere.ts): amounts another party's vault settle minted out of the
     *  temporary wallet's reach (lost for the user), as the sponsor reported them. */
    lost: z
      .array(
        z
          .object({
            kind: z.enum(['deposit', 'withdraw']),
            colour: hex64,
            amount: decimal,
            requestId: hex64.optional(),
            evmTx: z
              .string()
              .regex(/^0x[0-9a-fA-F]{64}$/)
              .optional(),
          })
          .strict(),
      )
      .max(8)
      .optional(),
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
    /** On a failed swap, the sponsor's word on whether a re-open revives it (P4.2-fix C5): true, the
     *  page offers Resume; false, final. Absent on a failed record written before the page kept the
     *  sponsor's "no" (P4.2-fix2 R3): only the sponsor can tell, so the page offers Resume. */
    recoverable: z.boolean().optional(),
    createdAt: ms,
    updatedAt: ms,
  })
  .strict()
  .superRefine((r, ctx) => {
    // The id is the salt's (derivation 2), or the salt itself (a legacy derivation-1 record).
    const want = r.derivation === 1 ? r.salt : swapIdOf(r.salt);
    if (r.swapId !== want) ctx.addIssue({ code: 'custom', message: "the swap id is not its salt's", path: ['swapId'] });
  });

/** A version-1 record (before P4.2-fix: the salt was the swap's id) as a legacy version 2. */
function upgradeV1(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const r = v as Record<string, unknown>;
  if (r.v !== 1 || 'salt' in r || r.derivation !== 1) return v;
  return { ...r, v: SWAP_RECORD_VERSION, salt: r.swapId };
}

export const SwapRecordSchema = z.preprocess(upgradeV1, SwapRecordV2);
export type SwapRecord = z.output<typeof SwapRecordV2>;

/** Terminal phases: nothing more will happen (unless a failed swap is `recoverable`: `isResumable`). */
export const isFinished = (r: Pick<SwapRecord, 'phase'>) => r.phase === 'done' || r.phase === 'failed';

/** A failed swap the sponsor said it can revive by a re-open (P4.2-fix C5). */
export const isRecoverable = (r: Pick<SwapRecord, 'phase' | 'recoverable'>) =>
  r.phase === 'failed' && r.recoverable === true;

/** A failed swap whose record does not say whether the sponsor can revive it: written before the
 *  sponsor said so (P4.2-fix) or before the page kept its "no" (P4.2-fix2 R3, the audit's F-B25).
 *  The sponsor decides, per its migration of such swaps: a re-open (Resume) asks it. */
export const isRecoverableUnknown = (r: Pick<SwapRecord, 'phase' | 'recoverable'>) =>
  r.phase === 'failed' && r.recoverable === undefined;

/** What the page offers Resume for: not finished; failed and recoverable; or failed and not known. */
export const isResumable = (r: Pick<SwapRecord, 'phase' | 'recoverable'>) =>
  !isFinished(r) || isRecoverable(r) || isRecoverableUnknown(r);

// The sponsor API as the page calls it (the plan's Lane contracts, "The sponsor API", and L-WEB's
// reading of its gaps). The HTTP is NOT written here (plan P3, L-SPONSOR's recommendation 3, one
// client per call): the calls before a swap token exists and the state polling go through core's
// `SponsorClient`, the calls authorised by the token through the wallet module's `sponsorClient`
// (`@evm-midnight-transparent/wallet/sponsor-client`, which imports no WASM). Both parse the
// sponsor's wire with core's schemas (swap-api.ts); this adapter then reads the answers the page's
// way (the tolerant `SwapView` below) and turns a failed fetch or an unreadable answer into core's
// `SponsorApiError` (exported here as `SponsorError`). In mock mode the `fetch` both clients use is
// the in-browser mock sponsor (./mock/sponsor.ts), so the same code runs in both.
//
//   GET  /v1/auth/nonce                      a single-use nonce for a SponsorAction signature
//   POST /v1/swaps                           open (or re-open, to resume) a swap: one SponsorAction
//                                            "open-swap" signature by the user's EVM address
//   GET  /v1/swaps/:id                       the swap's state machine        (Bearer swapToken)
//   GET  /v1/swaps/:id/withdraw-params       what `buildWithdraw` needs      (Bearer swapToken)
//   POST /v1/swaps/:id/prove                 prove a take or a withdrawal    (Bearer swapToken)
//   POST /v1/swaps/:id/withdraw              submit a bound withdrawal       (Bearer swapToken)
//   POST /v1/swaps/:id/take                  report how the take ended       (Bearer swapToken)
//
// As L-SPONSOR answered in the plan's Lane contracts (items 1–11). A 409 `stale-vault-state` or
// `stale-evm-nonce` on `/prove` or `/withdraw` means: release the draft, rebuild, prove again.
//
// The swap token is a bearer credential: callers keep it in memory only (never in a record).
// Responses are parsed strictly where the page relies on a field and tolerantly elsewhere (unknown
// fields dropped, unknown stage ids kept as text).

import {
  OPEN_SWAP_ACTION,
  SponsorApiError,
  SponsorClient,
  WITHDRAWAL_ENDINGS,
  payloadHash,
  sponsorActionTypedData,
  type NonceResponse,
  type SponsorActionMessage,
} from '@evm-midnight-transparent/core';
import { sponsorClient } from '@evm-midnight-transparent/wallet/sponsor-client';
import { getAddress, getBytes } from 'ethers';
import { z } from 'zod';

import type { TypedDataSigner, WithdrawParams } from './ports.js';

/** The SponsorAction name for opening a swap: core's (L-SPONSOR 1). */
export { OPEN_SWAP_ACTION };

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const swapIdRe = /^0x[0-9a-f]{64}$/;
const decimal = z.string().regex(/^\d+$/);
const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const optText = z.string().max(200).optional();

/** The sponsor sends `null` for an absent leg or hash (L-SPONSOR 4); the page reads it as absent. */
function dropNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(dropNulls);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== null)
        .map(([k, x]) => [k, dropNulls(x)]),
    );
  return v;
}

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

const StageSchema = z.object({
  stage: z.string().max(64),
  at: z.number(),
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type SponsorStage = z.infer<typeof StageSchema>;

const LegProgressSchema = z.object({
  requestId: optText,
  stage: optText,
  stages: z.array(StageSchema).max(64).optional(),
  startTx: optText,
  sweepTx: optText,
  completeTx: optText,
  sepoliaTx: optText,
  colour: optText,
  refunds: z.number().int().nonnegative().optional(),
});

/** `GET /v1/swaps/:id` (L-WEB's reading, item 4). */
const SwapViewShape = z.object({
  /** The sponsor answers the id without 0x (core `SwapIdSchema`); the page keeps it with. */
  swapId: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/)
    .transform((v) => `0x${v.replace(/^0x/i, '').toLowerCase()}`),
  state: z.enum(SWAP_STATES),
  deposit: LegProgressSchema.optional(),
  takeTx: optText,
  withdraw: LegProgressSchema.optional(),
  /** P4.2-fix C1: the latest withdrawal's ending and whether the page must rebuild it (`last`
   *  absent = null: the sponsor's nulls are dropped). An older sponsor sends none. */
  withdrawal: z
    .object({
      attempts: z.number().int().nonnegative(),
      last: z.enum(WITHDRAWAL_ENDINGS).optional(),
      retry: z.boolean(),
    })
    .optional(),
  outcome: z.enum(['swapped', 'bridged-back']).optional(),
  /** On `failed`: a stable code, and the sentence for the page. */
  reason: z.string().max(500).optional(),
  message: z.string().max(500).optional(),
  /** On `failed`: a re-open (resume) revives the swap (P4.2-fix C5). */
  recoverable: z.boolean().optional(),
});
export type SwapView = z.infer<typeof SwapViewShape>;
export const SwapViewSchema = z.preprocess(dropNulls, SwapViewShape);

export const SweepGasSchema = z.object({ gasLimit: decimal, maxFeePerGas: decimal, ethWei: decimal });
export type SweepGas = z.infer<typeof SweepGasSchema>;

export const OpenSwapResponseSchema = z.object({
  swapToken: z.string().min(16).max(512),
  depositAddress: evmAddress,
  sweepGas: SweepGasSchema,
  erc20Address: evmAddress,
  amount: decimal,
  swap: SwapViewSchema.optional(),
});
export type OpenSwapResponse = z.infer<typeof OpenSwapResponseSchema>;

const SwapAnswerSchema = z.object({ swap: SwapViewSchema });

/** What the user asks the sponsor to open: the offer's two legs and the temporary wallet's keys. */
export interface OpenSwapPayload {
  offerId: string;
  evmAddress: string;
  pay: { colour: string; amount: string };
  receive: { colour: string; amount: string };
  tempCoinPk: string;
  tempEncPk: string;
}

export interface OpenSwapRequest {
  swap: string;
  payload: OpenSwapPayload;
  auth: { message: SponsorActionMessage; signature: string };
}

/** Every sponsor error the page sees: core's `SponsorApiError` (`status`, `code`, `message`, `detail`,
 *  and `rebuild` for the stale answers that mean "rebuild the withdrawal and prove again"). */
export { SponsorApiError as SponsorError };

export type ProveRequest =
  { purpose: 'take'; tx: string } | { purpose: 'withdraw'; tx: string; coinNonce: string; evmNonce: string };

export type TakeReport = { outcome: 'taken'; takeTx: string } | { outcome: 'not-available' };

export interface SponsorApi {
  nonce(): Promise<NonceResponse>;
  openSwap(request: OpenSwapRequest): Promise<OpenSwapResponse>;
  swap(swapId: string, token: string): Promise<SwapView>;
  withdrawParams(swapId: string, token: string, kind: WithdrawParams['kind']): Promise<WithdrawParams>;
  prove(swapId: string, token: string, body: ProveRequest): Promise<{ tx: string }>;
  withdraw(swapId: string, token: string, body: { tx: string }): Promise<SwapView>;
  reportTake(swapId: string, token: string, report: TakeReport): Promise<SwapView>;
}

/** Build the open-swap SponsorAction message (Lane contracts item 1). Bound: the action, network,
 *  owner, swap, the exact payload, the sponsor's nonce and an expiry. */
export function openSwapMessage(input: {
  network: string;
  swapId: string;
  payload: OpenSwapPayload;
  nonce: string;
  expiry: number;
}): SponsorActionMessage {
  if (!swapIdRe.test(input.swapId)) throw new RangeError('the swap id must be 0x + 64 lowercase hex');
  return {
    action: OPEN_SWAP_ACTION,
    network: input.network,
    owner: getAddress(input.payload.evmAddress),
    swap: input.swapId,
    payloadHash: payloadHash(input.payload),
    nonce: input.nonce.toLowerCase(),
    expiry: String(input.expiry),
  };
}

/** Sign the open-swap action with the user's wallet: the third signature prompt of a start. */
export async function signOpenSwap(
  signer: TypedDataSigner,
  message: SponsorActionMessage,
  chainId: number,
): Promise<{ message: SponsorActionMessage; signature: string }> {
  const signature = await signer.signTypedData(sponsorActionTypedData(message, chainId));
  if (getBytes(signature).length !== 65)
    throw new SponsorApiError(0, 'bad-signature', 'the wallet returned a malformed signature');
  return { message, signature };
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/** How long a proof may take at the sponsor (its own limit is PROOF_TIMEOUT_SECONDS, 900 s). */
const PROVE_TIMEOUT_MS = 15 * 60_000;

const isZodError = (e: unknown) => (e as { name?: unknown } | null)?.name === 'ZodError';

/** A failed fetch or an unreadable answer, as the page words it; the sponsor's own errors pass through. */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof SponsorApiError) throw e;
    if (isZodError(e))
      throw new SponsorApiError(200, 'invalid-response', 'The sponsor service sent an answer this page cannot read.');
    throw new SponsorApiError(0, 'network', 'The sponsor service could not be reached.');
  }
}

export class HttpSponsorApi implements SponsorApi {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;
  /** The calls before a swap token exists, and the state polling. */
  private readonly core: SponsorClient;

  constructor(baseUrl: string, options: { fetch?: FetchImpl; timeoutMs?: number } = {}) {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new RangeError(`not a sponsor URL: ${baseUrl}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RangeError('the sponsor URL must be http(s)');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((u, i) => globalThis.fetch(u, i));
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.core = new SponsorClient({ baseUrl: this.baseUrl, fetch: this.fetchImpl, timeoutMs: this.timeoutMs });
  }

  /** The calls authorised by this swap's bearer token: the wallet module's client. */
  private withToken(swapId: string, token: string, timeoutMs = this.timeoutMs) {
    return sponsorClient({
      baseUrl: this.baseUrl,
      swapId,
      swapToken: token,
      fetchImpl: this.fetchImpl as typeof fetch,
      timeoutMs,
    });
  }

  nonce(): Promise<NonceResponse> {
    return guarded(() => this.core.nonce());
  }

  openSwap(request: OpenSwapRequest): Promise<OpenSwapResponse> {
    return guarded(async () =>
      OpenSwapResponseSchema.parse(await this.core.openSwap(request.swap, request.payload, request.auth)),
    );
  }

  swap(swapId: string, token: string): Promise<SwapView> {
    return guarded(async () => SwapViewSchema.parse(await this.core.swap(swapId, token)));
  }

  withdrawParams(swapId: string, token: string, kind: WithdrawParams['kind']): Promise<WithdrawParams> {
    return guarded(() => this.withToken(swapId, token).withdrawParams(kind));
  }

  prove(swapId: string, token: string, body: ProveRequest): Promise<{ tx: string }> {
    return guarded(async () => ({
      tx: await this.withToken(swapId, token, PROVE_TIMEOUT_MS).prove(
        body.purpose,
        body.tx,
        body.purpose === 'withdraw' ? { coinNonce: body.coinNonce, evmNonce: BigInt(body.evmNonce) } : undefined,
      ),
    }));
  }

  withdraw(swapId: string, token: string, body: { tx: string }): Promise<SwapView> {
    return guarded(async () => SwapAnswerSchema.parse(await this.withToken(swapId, token).withdraw(body.tx)).swap);
  }

  reportTake(swapId: string, token: string, report: TakeReport): Promise<SwapView> {
    return guarded(async () => SwapAnswerSchema.parse(await this.withToken(swapId, token).reportTake(report)).swap);
  }
}

/** Colours and keys as the sponsor wants them: 64 lowercase hex, no 0x. */
export const isHex64 = (v: string) => hex64.safeParse(v).success;

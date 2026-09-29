// The sponsor API client (the plan's Lane contracts, "The sponsor API", and L-WEB's reading of its
// gaps). This is the REAL client: P3 points it at the real sponsor; in mock mode its `fetch` is the
// in-browser mock sponsor (./mock/sponsor.ts), so the same code runs in both.
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
  NonceResponseSchema,
  payloadHash,
  sponsorActionTypedData,
  type NonceResponse,
  type SponsorActionMessage,
} from '@evm-midnight-transparent/core';
import { getAddress, getBytes } from 'ethers';
import { z } from 'zod';

import type { TypedDataSigner, WithdrawParams } from './ports.js';

/** The SponsorAction name for opening a swap (Lane contracts; core's list still has the P0
 *  placeholder `swap-open`, which L-SPONSOR replaces). */
export const OPEN_SWAP_ACTION = 'open-swap';

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
  swapId: z.string().regex(swapIdRe),
  state: z.enum(SWAP_STATES),
  deposit: LegProgressSchema.optional(),
  takeTx: optText,
  withdraw: LegProgressSchema.optional(),
  outcome: z.enum(['swapped', 'bridged-back']).optional(),
  reason: z.string().max(500).optional(),
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

const ProveResponseSchema = z.object({ tx: z.string().regex(/^(0x)?[0-9a-fA-F]+$/) });
const SwapAnswerSchema = z.object({ swap: SwapViewSchema });
const whole = z.union([z.string().regex(/^\d{1,40}$/), z.number().int().nonnegative()]).transform((v) => BigInt(v));
const WithdrawParamsSchema = z.object({
  kind: z.enum(['swap', 'bridge-back']),
  colour: z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/)
    .transform((v) => v.replace(/^0x/, '').toLowerCase()),
  amount: whole,
  erc20Address: evmAddress,
  dest: evmAddress,
  refundRecipient: z
    .union([z.string(), z.object({ left: z.string() })])
    .transform((v) => (typeof v === 'string' ? v : v.left).replace(/^0x/, '').toLowerCase())
    .pipe(hex64),
  gas: z.object({ gasLimit: whole, maxFeePerGas: whole, maxPriorityFeePerGas: whole, keyVersion: whole }),
  evmNonce: whole,
});
const ApiErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

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

export class SponsorError extends Error {
  override name = 'SponsorError';
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }

  /** The withdrawal must be rebuilt on fresh state and proven again (L-SPONSOR 8–9). */
  get rebuild(): boolean {
    return this.code === 'stale-vault-state' || this.code === 'stale-evm-nonce';
  }
}

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
    // Not yet in core's SPONSOR_ACTIONS (see OPEN_SWAP_ACTION); the typed data does not care.
    action: OPEN_SWAP_ACTION as SponsorActionMessage['action'],
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
    throw new SponsorError('the wallet returned a malformed signature', 0, 'bad-signature');
  return { message, signature };
}

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export class HttpSponsorApi implements SponsorApi {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly timeoutMs: number;

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
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: z.ZodType<T>,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new SponsorError('The sponsor service could not be reached.', 0, 'network');
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = ApiErrorBody.safeParse(json);
      throw new SponsorError(
        err.success ? err.data.error.message : `The sponsor service answered ${res.status}.`,
        res.status,
        err.success ? err.data.error.code : res.status === 429 ? 'rate-limited' : 'http',
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new SponsorError(
        'The sponsor service sent an answer this page cannot read.',
        res.status,
        'invalid-response',
      );
    return parsed.data;
  }

  nonce(): Promise<NonceResponse> {
    return this.call('GET', '/v1/auth/nonce', NonceResponseSchema);
  }

  openSwap(request: OpenSwapRequest): Promise<OpenSwapResponse> {
    return this.call('POST', '/v1/swaps', OpenSwapResponseSchema, { body: request });
  }

  swap(swapId: string, token: string): Promise<SwapView> {
    return this.call('GET', `/v1/swaps/${encodeURIComponent(swapId)}`, SwapViewSchema, { token });
  }

  withdrawParams(swapId: string, token: string, kind: WithdrawParams['kind']): Promise<WithdrawParams> {
    return this.call(
      'GET',
      `/v1/swaps/${encodeURIComponent(swapId)}/withdraw-params?kind=${kind}`,
      WithdrawParamsSchema,
      {
        token,
      },
    );
  }

  prove(swapId: string, token: string, body: ProveRequest): Promise<{ tx: string }> {
    return this.call('POST', `/v1/swaps/${encodeURIComponent(swapId)}/prove`, ProveResponseSchema, { token, body });
  }

  async withdraw(swapId: string, token: string, body: { tx: string }): Promise<SwapView> {
    return (
      await this.call('POST', `/v1/swaps/${encodeURIComponent(swapId)}/withdraw`, SwapAnswerSchema, { token, body })
    ).swap;
  }

  async reportTake(swapId: string, token: string, report: TakeReport): Promise<SwapView> {
    return (
      await this.call('POST', `/v1/swaps/${encodeURIComponent(swapId)}/take`, SwapAnswerSchema, { token, body: report })
    ).swap;
  }
}

/** Colours and keys as the sponsor wants them: 64 lowercase hex, no 0x. */
export const isHex64 = (v: string) => hex64.safeParse(v).success;

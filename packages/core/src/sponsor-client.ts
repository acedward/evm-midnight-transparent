// A small browser-safe client for the sponsor's swap API (./swap-api.ts). Fetch only; every answer
// is parsed with the shared schemas, and every error becomes a `SponsorApiError` carrying the
// sponsor's `{code, message, detail}`.
//
// The open-swap signature: ask `nonce()`, build the message with `openSwapMessage(...)`, have the
// user's wallet sign `sponsorActionTypedData(message)` (eth_signTypedData_v4), then `openSwap(...)`.
// The bearer token it answers with authorises every other call of that swap; keep it in memory.

import {
  SPONSOR_ACTIONS,
  buildSponsorActionMessage,
  type SignedSponsorAction,
  type SponsorActionMessage,
} from './auth.js';
import { ApiErrorSchema, NonceResponseSchema, type NonceResponse } from './api.js';
import {
  OpenSwapResponseSchema,
  ProveResponseSchema,
  SWAP_PATHS,
  SwapConfigSchema,
  SwapResponseSchema,
  WithdrawParamsSchema,
  type OpenSwapPayload,
  type OpenSwapResponse,
  type ProveRequest,
  type SwapConfig,
  type SwapView,
  type TakeReport,
  type WithdrawKind,
  type WithdrawParams,
} from './swap-api.js';

export class SponsorApiError extends Error {
  override name = 'SponsorApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export type SponsorFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The open-swap message to sign (`sponsorActionTypedData(message)`). */
export function openSwapMessage(input: {
  network: string;
  swapId: string;
  payload: OpenSwapPayload;
  nonce: string;
  expiry: number;
}): SponsorActionMessage {
  return buildSponsorActionMessage({
    action: SPONSOR_ACTIONS[0],
    network: input.network,
    owner: input.payload.evmAddress,
    swap: input.swapId,
    payload: input.payload,
    nonce: input.nonce,
    expiry: input.expiry,
  });
}

export class SponsorClient {
  private readonly base: string;
  private readonly fetchImpl: SponsorFetch;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl: string; fetch?: SponsorFetch; timeoutMs?: number }) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? ((u, i) => fetch(u, i));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async call(path: string, init: RequestInit & { token?: string }, timeoutMs = this.timeoutMs) {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const e = ApiErrorSchema.safeParse(json);
      throw e.success
        ? new SponsorApiError(res.status, e.data.error.code, e.data.error.message, e.data.error.detail)
        : new SponsorApiError(res.status, 'http', `the sponsor answered ${res.status}`);
    }
    return json;
  }

  async config(): Promise<SwapConfig> {
    return SwapConfigSchema.parse(await this.call(SWAP_PATHS.config, {}));
  }

  async nonce(): Promise<NonceResponse> {
    return NonceResponseSchema.parse(await this.call(SWAP_PATHS.nonce, {}));
  }

  async openSwap(swapId: string, payload: OpenSwapPayload, auth: SignedSponsorAction): Promise<OpenSwapResponse> {
    return OpenSwapResponseSchema.parse(
      await this.call(SWAP_PATHS.swaps, { method: 'POST', body: JSON.stringify({ swap: swapId, payload, auth }) }),
    );
  }

  async swap(swapId: string, token: string): Promise<SwapView> {
    return SwapResponseSchema.parse(await this.call(SWAP_PATHS.swap(swapId), { token })).swap;
  }

  async withdrawParams(swapId: string, token: string, kind: WithdrawKind): Promise<WithdrawParams> {
    return WithdrawParamsSchema.parse(
      await this.call(`${SWAP_PATHS.withdrawParams(swapId)}?kind=${encodeURIComponent(kind)}`, { token }),
    );
  }

  /** Prove on the sponsor's proof server: the answer is `Transaction<signature, proof, pre-binding>` hex. */
  async prove(swapId: string, token: string, body: ProveRequest): Promise<string> {
    const out = await this.call(
      SWAP_PATHS.prove(swapId),
      { method: 'POST', body: JSON.stringify(body), token },
      15 * 60_000,
    );
    return ProveResponseSchema.parse(out).tx;
  }

  async withdraw(swapId: string, token: string, txHex: string): Promise<SwapView> {
    return SwapResponseSchema.parse(
      await this.call(SWAP_PATHS.withdraw(swapId), { method: 'POST', body: JSON.stringify({ tx: txHex }), token }),
    ).swap;
  }

  async reportTake(swapId: string, token: string, report: TakeReport): Promise<SwapView> {
    return SwapResponseSchema.parse(
      await this.call(SWAP_PATHS.take(swapId), { method: 'POST', body: JSON.stringify(report), token }),
    ).swap;
  }
}

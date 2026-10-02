// A small browser-safe client for the sponsor's swap API (./swap-api.ts): the calls made BEFORE a
// swap token exists (`config`, `nonce`, `openSwap`) and the state polling (`swap`). Fetch only;
// every answer is parsed with the shared schemas, and every error becomes a `SponsorApiError`
// carrying the sponsor's `{code, message, detail}`.
//
// One client per call (plan 00048 P3, L-SPONSOR's recommendation 3): the calls authorised by the
// swap's bearer token (`/prove`, `/withdraw`, `withdraw-params`, `/take`) are the wallet module's
// `sponsorClient` (@evm-midnight-transparent/wallet/sponsor-client), which types `withdraw-params`
// for `buildWithdraw`; both throw this module's `SponsorApiError`.
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
  SWAP_PATHS,
  SwapConfigSchema,
  SwapResponseSchema,
  type OpenSwapPayload,
  type OpenSwapResponse,
  type SwapConfig,
  type SwapView,
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

  /** The withdrawal must be rebuilt on fresh state and proven again (a 409 on `/prove` or `/withdraw`). */
  get rebuild(): boolean {
    return this.code === 'stale-vault-state' || this.code === 'stale-evm-nonce';
  }

  /** A passing failure, not a refusal (plan 00048 P4.5): no answer at all (a network error or a
   *  timeout: status 0, code `network`), 408, 429 (too many requests), or any 5xx (a gateway's 502,
   *  503 or 504 while the sponsor is down or restarting, or the sponsor's own coded "try again": busy,
   *  low on fees, the proof server or Sepolia unavailable). The caller waits and asks again; it never
   *  gives up on a swap for it. A 4xx with a code is the sponsor's definitive answer. */
  get transient(): boolean {
    return (
      (this.status === 0 && this.code === 'network') ||
      this.status === 408 ||
      this.status === 429 ||
      (this.status >= 500 && this.status <= 599)
    );
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
        : res.status === 429
          ? new SponsorApiError(
              429,
              'rate-limited',
              'The sponsor service is busy: too many requests. Try again shortly.',
            )
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
}

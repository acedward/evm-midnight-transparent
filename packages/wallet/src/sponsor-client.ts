// The two sponsor calls the wallet makes (plan "Lane contracts", the sponsor API 4 and 5), with the
// swap's bearer token:
//
//   POST {base}/v1/swaps/:id/prove     {purpose: "take" | "withdraw", tx: <unproven hex>} → {tx: <proven hex>}
//   POST {base}/v1/swaps/:id/withdraw  {tx: <proven, bound startWithdraw hex>}           → {swap: SwapView}
//
// The sponsor proves with ITS proof server and key directory, so the browser downloads no key
// material; the proof request carries the temporary wallet's spend witnesses to our own server
// (spec Q3 A). Errors are core's `ApiError` (`{error: {code, message, detail?}}`).
// The swap token is a bearer credential: it lives in memory only, like the key.

import { type ApiError, ApiErrorSchema } from '@evm-midnight-transparent/core';

import { type UnprovenTx, provenUnboundFromHex, txToHex } from './tx.js';
import { type ProvingService } from './prover.js';

export type ProvePurpose = 'take' | 'withdraw';

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

export interface SponsorClientOptions {
  /** The sponsor's origin, e.g. `https://sponsor.example` (no trailing `/v1`). */
  baseUrl: string;
  /** The swap id (its salt): `0x` + 64 hex. */
  swapId: string;
  /** The bearer token `POST /v1/swaps` returned. */
  swapToken: string;
  fetchImpl?: typeof fetch;
  /** Per request (default 10 minutes: a vault proof takes seconds, but the proof lane can queue). */
  timeoutMs?: number;
}

export interface SponsorClient {
  /** `/prove`: the proven transaction, hex (normally pre-binding; `finalizeTake`/`finalizeWithdraw` bind it). */
  prove(purpose: ProvePurpose, unprovenHex: string): Promise<string>;
  /** `/withdraw`: the sponsor adds DUST and submits in its withdrawal lane. Returns its answer (`{swap}`). */
  withdraw(finalizedHex: string): Promise<unknown>;
}

const HEX = /^[0-9a-f]+$/;

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function sponsorClient(o: SponsorClientOptions): SponsorClient {
  if (!/^0x[0-9a-fA-F]{64}$/.test(o.swapId))
    throw new SponsorApiError(0, 'bad-request', 'the swap id must be 0x + 64 hex');
  if (o.swapToken.trim() === '') throw new SponsorApiError(0, 'bad-request', 'the swap token is empty');
  const base = o.baseUrl.replace(/\/+$/, '');
  const f = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 600_000;
  const url = (tail: string) => `${base}/v1/swaps/${encodeURIComponent(o.swapId.toLowerCase())}/${tail}`;

  async function post(tail: string, body: unknown): Promise<unknown> {
    const res = await f(url(tail), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${o.swapToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const parsed = parseJson(text);
    if (!res.ok) {
      const e = ApiErrorSchema.safeParse(parsed);
      const err: ApiError['error'] = e.success
        ? e.data.error
        : { code: `http-${res.status}`, message: text.slice(0, 300) || res.statusText };
      throw new SponsorApiError(res.status, err.code, err.message, err.detail);
    }
    return parsed;
  }

  const hexOf = (tx: string, label: string) => {
    const h = tx.trim().replace(/^0x/, '').toLowerCase();
    if (!HEX.test(h) || h.length % 2 !== 0) throw new SponsorApiError(0, 'bad-request', `the ${label} is not hex`);
    return h;
  };

  return {
    async prove(purpose, unprovenHex) {
      const out = (await post('prove', { purpose, tx: hexOf(unprovenHex, 'transaction') })) as
        { tx?: unknown } | undefined;
      if (!out || typeof out.tx !== 'string')
        throw new SponsorApiError(200, 'bad-response', 'the sponsor returned no transaction');
      return hexOf(out.tx, 'proven transaction');
    },
    async withdraw(finalizedHex) {
      return post('withdraw', { tx: hexOf(finalizedHex, 'transaction') });
    },
  };
}

/** A `ProvingService` over the sponsor's `/prove` (for code written against the SDK's proving service). */
export function sponsorProvingService(client: SponsorClient, purpose: ProvePurpose): ProvingService {
  return { prove: async (tx: UnprovenTx) => provenUnboundFromHex(await client.prove(purpose, txToHex(tx))) };
}

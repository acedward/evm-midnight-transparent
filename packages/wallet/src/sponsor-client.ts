// The sponsor calls the wallet makes (plan "Lane contracts": the sponsor API 4 and 5, and L-SPONSOR's
// answer 7-10), with the swap's bearer token:
//
//   GET  {base}/v1/swaps/:id/withdraw-params?kind=swap|bridge-back   → what startWithdraw needs but the coin
//   POST {base}/v1/swaps/:id/prove    {purpose: "take", tx, walletOutputs}                            → {tx: <proven hex>}
//                                     {purpose: "withdraw", tx, coinNonce, evmNonce, walletOutputs}   → {tx: <proven hex>}
//   POST {base}/v1/swaps/:id/withdraw {tx: <proven, BOUND startWithdraw hex>}          → 202 {swap}
//   POST {base}/v1/swaps/:id/take     {outcome: "taken", takeTx} | {outcome: "not-available"}
//
// `tx` sent to `/prove` is the unproven transaction's hex; the answer is the proven, pre-binding one
// (`finalizeTake` / `finalizeWithdraw` bind it). The sponsor proves with ITS proof server and key
// directory, so the browser downloads no key material; the proof request carries the temporary
// wallet's spend witnesses to our own server (spec Q3 A). Errors are core's `ApiError`
// (`{error: {code, message, detail?}}`): `stale-vault-state` and `stale-evm-nonce` (409) mean
// "rebuild the withdrawal and prove again".
// `walletOutputs` (P4.2-fix2 R1): every coin the transaction pays back to the temporary wallet, as
// `{nonce, colour, value}` (./outputs.ts), so the sponsor can account for every output it proves. A
// sponsor from before that change refuses the unknown field (its schema is strict: 400
// `bad-request`); the proof is then asked once more without it (transitional).
// The swap token is a bearer credential: it lives in memory only, like the key.
//
// This module imports core only (no WASM): the web app loads it with its first bundle, as
// `@evm-midnight-transparent/wallet/sponsor-client`, while the wallet itself loads lazily. Errors are
// core's `SponsorApiError` (one class for every sponsor call; `rebuild` marks the stale answers).

import { type ApiError, ApiErrorSchema, type EvmGasPolicy, SponsorApiError } from '@evm-midnight-transparent/core';

export { SponsorApiError };

export type ProvePurpose = 'take' | 'withdraw';
export type WithdrawKind = 'swap' | 'bridge-back';

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

/** The sponsor's `withdraw-params`, typed: `buildWithdraw` takes it as its input. */
export interface WithdrawParams {
  kind: WithdrawKind;
  colour: string;
  amount: bigint;
  erc20Address: string;
  dest: string;
  refundRecipient: string;
  gas: EvmGasPolicy;
  evmNonce: bigint;
}

/** `/prove`'s withdraw hints: public values the sponsor rebuilds the call from. */
export interface WithdrawHints {
  /** The nonce of the coin the call hands to the vault (`WithdrawDraft.coinNonce`), 64 hex. */
  coinNonce: string;
  evmNonce: bigint;
}

export type TakeReport = { outcome: 'taken'; takeTx: string } | { outcome: 'not-available' };

/** A coin the transaction pays to the temporary wallet (P4.2-fix2 R1): public values only. */
export interface WalletOutput {
  /** 64 lowercase hex. */
  nonce: string;
  /** The shielded colour, 64 lowercase hex. */
  colour: string;
  /** Base units. */
  value: bigint;
}

/** What `/prove` discloses besides the transaction (P4.2-fix2 R1). */
export interface ProveDisclosure {
  walletOutputs?: readonly WalletOutput[];
}

export interface SponsorClient {
  /** `/prove`: the proven transaction, hex (normally pre-binding; `finalizeTake`/`finalizeWithdraw` bind it).
   *  `withdraw` needs `hints`; `disclosure.walletOutputs` are the draft's (P4.2-fix2 R1). */
  prove(
    purpose: ProvePurpose,
    unprovenHex: string,
    hints?: WithdrawHints,
    disclosure?: ProveDisclosure,
  ): Promise<string>;
  /** `/withdraw`: the sponsor adds DUST and submits in its withdrawal lane. Returns its answer (`{swap}`). */
  withdraw(finalizedHex: string): Promise<unknown>;
  /** `withdraw-params`: the colour, amount, destination, gas and the lane's EVM nonce. */
  withdrawParams(kind: WithdrawKind): Promise<WithdrawParams>;
  /** `/take`: tell the sponsor how the take ended. */
  reportTake(report: TakeReport): Promise<unknown>;
}

const HEX = /^[0-9a-f]+$/;
const DECIMAL = /^[0-9]{1,40}$/;

function parseJson(text: string): unknown {
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const bad = (message: string) => new SponsorApiError(200, 'bad-response', message);

function big(v: unknown, label: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && DECIMAL.test(v)) return BigInt(v);
  throw bad(`withdraw-params: ${label} is not a whole number`);
}

function str(v: unknown, label: string, re: RegExp): string {
  if (typeof v !== 'string' || !re.test(v)) throw bad(`withdraw-params: ${label} is malformed`);
  return v;
}

/** Parse the sponsor's `withdraw-params` answer (whole numbers as decimal strings or numbers). */
export function parseWithdrawParams(raw: unknown, kind: WithdrawKind): WithdrawParams {
  const o = (raw ?? {}) as Record<string, unknown>;
  const g = (o.gas ?? {}) as Record<string, unknown>;
  const hex64 = /^(0x)?[0-9a-fA-F]{64}$/;
  const evm = /^0x[0-9a-fA-F]{40}$/;
  const refund = o.refundRecipient;
  const refundHex =
    typeof refund === 'object' && refund !== null && 'left' in refund
      ? String((refund as { left: unknown }).left)
      : String(refund ?? '');
  const k = o.kind === undefined ? kind : o.kind;
  if (k !== kind) throw bad(`withdraw-params: asked for ${kind}, got ${String(k)}`);
  return {
    kind,
    colour: str(o.colour, 'colour', hex64).replace(/^0x/, '').toLowerCase(),
    amount: big(o.amount, 'amount'),
    erc20Address: str(o.erc20Address, 'erc20Address', evm),
    dest: str(o.dest, 'dest', evm),
    refundRecipient: str(refundHex, 'refundRecipient', hex64).replace(/^0x/, '').toLowerCase(),
    gas: {
      gasLimit: big(g.gasLimit, 'gas.gasLimit'),
      maxFeePerGas: big(g.maxFeePerGas, 'gas.maxFeePerGas'),
      maxPriorityFeePerGas: big(g.maxPriorityFeePerGas, 'gas.maxPriorityFeePerGas'),
      keyVersion: big(g.keyVersion, 'gas.keyVersion'),
    },
    evmNonce: big(o.evmNonce, 'evmNonce'),
  };
}

export function sponsorClient(o: SponsorClientOptions): SponsorClient {
  if (!/^0x[0-9a-fA-F]{64}$/.test(o.swapId))
    throw new SponsorApiError(0, 'bad-request', 'the swap id must be 0x + 64 hex');
  if (o.swapToken.trim() === '') throw new SponsorApiError(0, 'bad-request', 'the swap token is empty');
  const base = o.baseUrl.replace(/\/+$/, '');
  const f = o.fetchImpl ?? fetch;
  const timeoutMs = o.timeoutMs ?? 600_000;
  const url = (tail: string) => `${base}/v1/swaps/${encodeURIComponent(o.swapId.toLowerCase())}/${tail}`;

  async function call(method: 'GET' | 'POST', tail: string, body?: unknown): Promise<unknown> {
    const res = await f(url(tail), {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        authorization: `Bearer ${o.swapToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const parsed = parseJson(text);
    if (!res.ok) {
      const e = ApiErrorSchema.safeParse(parsed);
      const err: ApiError['error'] = e.success
        ? e.data.error
        : res.status === 429
          ? { code: 'rate-limited', message: 'The sponsor service is busy: too many requests. Try again shortly.' }
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

  const outputOf = (o: WalletOutput) => {
    const nonce = hexOf(o.nonce, 'output nonce');
    const colour = hexOf(o.colour, 'output colour');
    if (nonce.length !== 64 || colour.length !== 64 || o.value < 0n)
      throw new SponsorApiError(0, 'bad-request', 'a disclosed output must be 32-byte nonce and colour and a value');
    return { nonce, colour, value: o.value.toString(10) };
  };

  return {
    async prove(purpose, unprovenHex, hints, disclosure) {
      const body: Record<string, unknown> = { purpose, tx: hexOf(unprovenHex, 'transaction') };
      if (purpose === 'withdraw') {
        if (!hints) throw new SponsorApiError(0, 'bad-request', 'a withdrawal proof needs the coin and EVM nonces');
        const coinNonce = hexOf(hints.coinNonce, 'coin nonce');
        if (coinNonce.length !== 64) throw new SponsorApiError(0, 'bad-request', 'the coin nonce must be 32 bytes');
        body.coinNonce = coinNonce;
        body.evmNonce = hints.evmNonce.toString(10);
      }
      if (disclosure?.walletOutputs !== undefined) body.walletOutputs = disclosure.walletOutputs.map(outputOf);
      let out: { tx?: unknown } | undefined;
      try {
        out = (await call('POST', 'prove', body)) as { tx?: unknown } | undefined;
      } catch (e) {
        // A sponsor from before P4.2-fix2 refuses the unknown `walletOutputs` (400 bad-request): ask
        // once more without it. A current sponsor never answers a well-formed request so.
        if (
          !('walletOutputs' in body) ||
          !(e instanceof SponsorApiError) ||
          e.status !== 400 ||
          e.code !== 'bad-request'
        )
          throw e;
        delete body.walletOutputs;
        out = (await call('POST', 'prove', body)) as { tx?: unknown } | undefined;
      }
      if (!out || typeof out.tx !== 'string') throw bad('the sponsor returned no transaction');
      return hexOf(out.tx, 'proven transaction');
    },
    async withdraw(finalizedHex) {
      return call('POST', 'withdraw', { tx: hexOf(finalizedHex, 'transaction') });
    },
    async withdrawParams(kind) {
      return parseWithdrawParams(await call('GET', `withdraw-params?kind=${kind}`), kind);
    },
    async reportTake(report) {
      if (report.outcome === 'taken' && !/^(0x)?[0-9a-fA-F]{64}$/.test(report.takeTx)) {
        throw new SponsorApiError(0, 'bad-request', 'the take transaction hash must be 32 bytes of hex');
      }
      return call(
        'POST',
        'take',
        report.outcome === 'taken'
          ? { outcome: 'taken', takeTx: report.takeTx.replace(/^0x/, '').toLowerCase() }
          : { outcome: 'not-available' },
      );
    },
  };
}

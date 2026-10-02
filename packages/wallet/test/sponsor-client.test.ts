import * as ledger from '@midnightntwrk/ledger-v9';
import { describe, expect, it, vi } from 'vitest';

import {
  SponsorApiError,
  parseWithdrawParams,
  sponsorClient,
  sponsorProvingService,
  txToHex,
  unprovenFromHex,
} from '../src/index.js';

const SWAP = `0x${'AB'.repeat(32)}`;
const TOKEN = 'swap-token-for-tests';

type Call = [string | URL | Request, RequestInit | undefined];
const fetchReturning = (status: number, body: unknown) =>
  vi.fn(async (..._args: Call) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));

describe('the sponsor client', () => {
  it('POSTs /v1/swaps/:id/prove with the bearer token and returns the proven hex', async () => {
    const f = fetchReturning(200, { tx: '0xABCD' });
    const c = sponsorClient({
      baseUrl: 'https://sponsor.example/',
      swapId: SWAP,
      swapToken: TOKEN,
      fetchImpl: f as never,
    });
    expect(await c.prove('take', '0x0102')).toBe('abcd');
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(`https://sponsor.example/v1/swaps/0x${'ab'.repeat(32)}/prove`);
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init!.body))).toEqual({ purpose: 'take', tx: '0102' });
  });

  it('discloses the wallet outputs with a proof (P4.2-fix2 R1): decimal values, lowercase hex', async () => {
    const f = fetchReturning(200, { tx: 'ab' });
    const c = sponsorClient({ baseUrl: 'https://s', swapId: SWAP, swapToken: TOKEN, fetchImpl: f as never });
    const out = { nonce: `0x${'1A'.repeat(32)}`, colour: '2b'.repeat(32), value: 18_446_744_073_709_551_615n };
    await c.prove('take', '01', undefined, { walletOutputs: [out] });
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({
      purpose: 'take',
      tx: '01',
      walletOutputs: [{ nonce: '1a'.repeat(32), colour: '2b'.repeat(32), value: '18446744073709551615' }],
    });
    await c.prove('withdraw', '01', { coinNonce: 'cc'.repeat(32), evmNonce: 9n }, { walletOutputs: [] });
    expect(JSON.parse(String(f.mock.calls[1]![1]!.body))).toMatchObject({ purpose: 'withdraw', walletOutputs: [] });
    await expect(c.prove('take', '01', undefined, { walletOutputs: [{ ...out, nonce: 'ab' }] })).rejects.toMatchObject({
      code: 'bad-request',
    });
  });

  it('a sponsor before P4.2-fix2 (strict schema, 400 bad-request): the proof is asked once more without the field', async () => {
    const f = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as Record<string, unknown>;
      return 'walletOutputs' in body
        ? new Response(
            JSON.stringify({ error: { code: 'bad-request', message: 'the request does not have the expected shape' } }),
            { status: 400 },
          )
        : new Response(JSON.stringify({ tx: 'cd' }), { status: 200 });
    });
    const c = sponsorClient({ baseUrl: 'https://s', swapId: SWAP, swapToken: TOKEN, fetchImpl: f as never });
    const out = { nonce: '1a'.repeat(32), colour: '2b'.repeat(32), value: 1n };
    expect(await c.prove('take', '01', undefined, { walletOutputs: [out] })).toBe('cd');
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(f.mock.calls[1]![1]!.body))).toEqual({ purpose: 'take', tx: '01' });
    // Any other refusal is final: no second request.
    const g = fetchReturning(422, { error: { code: 'invalid-tx', message: 'no', detail: 'undisclosed-output' } });
    const d = sponsorClient({ baseUrl: 'https://s', swapId: SWAP, swapToken: TOKEN, fetchImpl: g as never });
    await expect(d.prove('take', '01', undefined, { walletOutputs: [out] })).rejects.toMatchObject({
      status: 422,
      code: 'invalid-tx',
    });
    expect(g).toHaveBeenCalledTimes(1);
    // Without a disclosure, a 400 is final too.
    const h = fetchReturning(400, { error: { code: 'bad-request', message: 'no' } });
    const e = sponsorClient({ baseUrl: 'https://s', swapId: SWAP, swapToken: TOKEN, fetchImpl: h as never });
    await expect(e.prove('take', '01')).rejects.toMatchObject({ status: 400 });
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('POSTs /withdraw and returns the answer', async () => {
    const f = fetchReturning(200, { swap: { state: 'withdrawing' } });
    const c = sponsorClient({
      baseUrl: 'https://sponsor.example',
      swapId: SWAP,
      swapToken: TOKEN,
      fetchImpl: f as never,
    });
    expect(await c.withdraw('ff00')).toEqual({ swap: { state: 'withdrawing' } });
    expect(String(f.mock.calls[0]![0])).toMatch(/\/withdraw$/);
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({ tx: 'ff00' });
  });

  it("maps core's ApiError, and anything else, to SponsorApiError", async () => {
    const refused = sponsorClient({
      baseUrl: 'https://s',
      swapId: SWAP,
      swapToken: TOKEN,
      fetchImpl: fetchReturning(422, {
        error: { code: 'not-this-swap', message: 'the transaction does not take this offer', detail: 'x' },
      }) as never,
    });
    await expect(refused.prove('take', '00')).rejects.toMatchObject({
      status: 422,
      code: 'not-this-swap',
      detail: 'x',
    });
    const html = sponsorClient({
      baseUrl: 'https://s',
      swapId: SWAP,
      swapToken: TOKEN,
      fetchImpl: fetchReturning(502, '<html>bad gateway</html>') as never,
    });
    await expect(html.prove('take', '00')).rejects.toMatchObject({ status: 502, code: 'http-502' });
    const empty = sponsorClient({
      baseUrl: 'https://s',
      swapId: SWAP,
      swapToken: TOKEN,
      fetchImpl: fetchReturning(200, {}) as never,
    });
    await expect(empty.prove('take', '00')).rejects.toMatchObject({ code: 'bad-response' });
  });

  it('refuses a malformed swap id, an empty token or a non-hex transaction before any request', async () => {
    const f = fetchReturning(200, {});
    expect(() =>
      sponsorClient({ baseUrl: 'https://s', swapId: '0x12', swapToken: TOKEN, fetchImpl: f as never }),
    ).toThrow(SponsorApiError);
    expect(() => sponsorClient({ baseUrl: 'https://s', swapId: SWAP, swapToken: ' ', fetchImpl: f as never })).toThrow(
      SponsorApiError,
    );
    const c = sponsorClient({ baseUrl: 'https://s', swapId: SWAP, swapToken: TOKEN, fetchImpl: f as never });
    await expect(c.prove('take', 'xyz')).rejects.toMatchObject({ code: 'bad-request' });
    await expect(c.withdraw('abc')).rejects.toMatchObject({ code: 'bad-request' });
    expect(f).not.toHaveBeenCalled();
  });

  it('serves as a proving service: sends the unproven hex, parses a pre-binding answer', async () => {
    const f = fetchReturning(200, { tx: 'ab' });
    const svc = sponsorProvingService(
      sponsorClient({ baseUrl: 'https://s', swapId: SWAP, swapToken: TOKEN, fetchImpl: f as never }),
      'take',
    );
    const empty = ledger.Transaction.fromParts('stagenet');
    expect(unprovenFromHex(txToHex(empty)).serialize()).toEqual(empty.serialize());
    await expect(svc.prove(empty)).rejects.toThrow(/not a proven/);
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body)).purpose).toBe('take');
  });

  it('sends the withdraw hints /prove needs, and refuses a withdraw proof without them', async () => {
    const f = fetchReturning(200, { tx: 'cd' });
    const c = sponsorClient({ baseUrl: 'https://s', swapId: SWAP, swapToken: TOKEN, fetchImpl: f as never });
    expect(await c.prove('withdraw', '01', { coinNonce: `0x${'CC'.repeat(32)}`, evmNonce: 9n })).toBe('cd');
    expect(JSON.parse(String(f.mock.calls[0]![1]!.body))).toEqual({
      purpose: 'withdraw',
      tx: '01',
      coinNonce: 'cc'.repeat(32),
      evmNonce: '9',
    });
    await expect(c.prove('withdraw', '01')).rejects.toMatchObject({ code: 'bad-request' });
    await expect(c.prove('withdraw', '01', { coinNonce: 'cc', evmNonce: 1n })).rejects.toMatchObject({
      code: 'bad-request',
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('marks stale state and stale nonces as "rebuild"', async () => {
    for (const [code, rebuild] of [
      ['stale-vault-state', true],
      ['stale-evm-nonce', true],
      ['not-this-swap', false],
    ] as const) {
      const c = sponsorClient({
        baseUrl: 'https://s',
        swapId: SWAP,
        swapToken: TOKEN,
        fetchImpl: fetchReturning(409, { error: { code, message: code } }) as never,
      });
      const err = await c.withdraw('00').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SponsorApiError);
      expect((err as SponsorApiError).rebuild).toBe(rebuild);
    }
  });

  it('GETs withdraw-params and types them for buildWithdraw', async () => {
    const f = fetchReturning(200, {
      kind: 'swap',
      colour: 'AB'.repeat(32),
      amount: '1000000',
      erc20Address: '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52',
      dest: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
      refundRecipient: { left: 'CD'.repeat(32) },
      gas: { gasLimit: '100000', maxFeePerGas: '10000000000', maxPriorityFeePerGas: 1000000000, keyVersion: '1' },
      evmNonce: '12',
    });
    const c = sponsorClient({ baseUrl: 'https://s', swapId: SWAP, swapToken: TOKEN, fetchImpl: f as never });
    expect(await c.withdrawParams('swap')).toEqual({
      kind: 'swap',
      colour: 'ab'.repeat(32),
      amount: 1_000_000n,
      erc20Address: '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52',
      dest: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
      refundRecipient: 'cd'.repeat(32),
      gas: { gasLimit: 100_000n, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, keyVersion: 1n },
      evmNonce: 12n,
    });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toMatch(/\/withdraw-params\?kind=swap$/);
    expect(init!.method).toBe('GET');
    expect(init!.body).toBeUndefined();
    expect(() => parseWithdrawParams({ kind: 'swap' }, 'bridge-back')).toThrow(/asked for bridge-back/);
    expect(() => parseWithdrawParams({ colour: 'ab'.repeat(32), amount: '-1' }, 'swap')).toThrow(SponsorApiError);
  });

  it("reports the take's outcome", async () => {
    const f = fetchReturning(200, { swap: {} });
    const c = sponsorClient({ baseUrl: 'https://s', swapId: SWAP, swapToken: TOKEN, fetchImpl: f as never });
    await c.reportTake({ outcome: 'taken', takeTx: `0x${'EF'.repeat(32)}` });
    await c.reportTake({ outcome: 'not-available' });
    expect(f.mock.calls.map((x) => JSON.parse(String(x[1]!.body)))).toEqual([
      { outcome: 'taken', takeTx: 'ef'.repeat(32) },
      { outcome: 'not-available' },
    ]);
    await expect(c.reportTake({ outcome: 'taken', takeTx: 'ef' })).rejects.toMatchObject({ code: 'bad-request' });
  });
});

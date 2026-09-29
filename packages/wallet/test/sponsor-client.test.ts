import * as ledger from '@midnightntwrk/ledger-v9';
import { describe, expect, it, vi } from 'vitest';

import { SponsorApiError, sponsorClient, sponsorProvingService, txToHex, unprovenFromHex } from '../src/index.js';

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
    await expect(html.prove('withdraw', '00')).rejects.toMatchObject({ status: 502, code: 'http-502' });
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
});

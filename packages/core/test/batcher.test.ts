// The batcher envelope a take is submitted in (the zswap SPA's, byte for byte), and how its answers
// are read. No network: a fake fetch.

import { describe, expect, it } from 'vitest';

import { BALANCER_TARGET, MAX_INPUT_CHARS, batcherBody, submitToBatcher } from '../src/batcher.js';

const at = () => new Date('2026-09-29T12:00:00.000Z');
const ADDRESS = 'mn_addr_stagenet1example';

describe('batcherBody', () => {
  it('wraps a finalized transaction for midnight-balancer, waiting for the receipt', () => {
    const { body, inputChars } = batcherBody({
      batcherUrl: 'https://b.test',
      txHex: '0xABCD',
      address: ADDRESS,
      now: at,
    });
    expect(body).toEqual({
      data: {
        address: ADDRESS,
        addressType: 5,
        input: '{"tx":"abcd","txStage":"finalized"}',
        timestamp: '2026-09-29T12:00:00.000Z',
        target: BALANCER_TARGET,
      },
      confirmationLevel: 'wait-receipt',
      timeoutMs: 600_000,
    });
    expect(inputChars).toBe('{"tx":"abcd","txStage":"finalized"}'.length);
  });

  it('refuses what is not hex, and an input over the batcher cap', () => {
    expect(() => batcherBody({ batcherUrl: 'https://b.test', txHex: 'xyz', address: ADDRESS })).toThrow(/not hex/);
    expect(() => batcherBody({ batcherUrl: 'https://b.test', txHex: 'abc', address: ADDRESS })).toThrow(/not hex/);
    const big = 'ab'.repeat(MAX_INPUT_CHARS / 2);
    expect(() => batcherBody({ batcherUrl: 'https://b.test', txHex: big, address: ADDRESS })).toThrow(/at most 500000/);
  });
});

describe('submitToBatcher', () => {
  const fake =
    (status: number, body: unknown, seen: { url?: string; body?: unknown } = {}) =>
    async (url: string | URL | Request, init?: RequestInit) => {
      seen.url = String(url);
      seen.body = JSON.parse(String(init?.body));
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    };

  it('posts to /send-input and reports success with the transaction hash', async () => {
    const seen: { url?: string; body?: unknown } = {};
    const r = await submitToBatcher({
      batcherUrl: 'https://b.test/',
      txHex: 'abcd',
      address: ADDRESS,
      now: at,
      fetchImpl: fake(200, { success: true, transactionHash: 'ff'.repeat(32) }, seen) as typeof fetch,
    });
    expect(seen.url).toBe('https://b.test/send-input');
    expect(r).toMatchObject({ ok: true, httpStatus: 200, transactionHash: 'ff'.repeat(32) });
  });

  it('reports a refusal with its error text (a lost race, a node error)', async () => {
    const r = await submitToBatcher({
      batcherUrl: 'https://b.test',
      txHex: 'abcd',
      address: ADDRESS,
      fetchImpl: fake(500, { success: false, error: 'Custom error: 239' }) as typeof fetch,
    });
    expect(r).toMatchObject({ ok: false, httpStatus: 500, error: 'Custom error: 239' });
    const plain = await submitToBatcher({
      batcherUrl: 'https://b.test',
      txHex: 'abcd',
      address: ADDRESS,
      fetchImpl: fake(429, 'Too Many Requests') as typeof fetch,
    });
    expect(plain).toMatchObject({ ok: false, httpStatus: 429, error: 'Too Many Requests' });
  });
});

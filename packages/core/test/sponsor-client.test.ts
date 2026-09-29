// The sponsor API's shared schemas and the browser's fetch client (../src/swap-api.ts,
// ../src/sponsor-client.ts), against a fake fetch.

import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  OpenSwapRequestSchema,
  ProveRequestSchema,
  SPONSOR_ACTION_TYPES,
  SponsorApiError,
  SponsorClient,
  TakeReportSchema,
  openSwapMessage,
  recoverSponsorActionSigner,
  sponsorDomain,
  verifySponsorAction,
  type OpenSwapPayload,
} from '../src/index.js';

const hex = (b: string) => b.repeat(32);

function payloadFor(address: string): OpenSwapPayload {
  return {
    offerId: hex('9e'),
    evmAddress: address,
    pay: { colour: hex('5e'), amount: '104166667' },
    receive: { colour: hex('e5'), amount: '1000000' },
    tempCoinPk: hex('6b'),
    tempEncPk: hex('bb'),
  };
}

describe('the open-swap signature', () => {
  it('binds the swap id, the owner and the whole payload, and the sponsor accepts it once', async () => {
    const user = Wallet.createRandom();
    const payload = payloadFor(user.address);
    const nonce = `0x${'12'.repeat(32)}`;
    const message = openSwapMessage({ network: 'stagenet', swapId: hex('ab'), payload, nonce, expiry: 2_000_000_000 });
    expect(message).toMatchObject({
      action: 'open-swap',
      network: 'stagenet',
      swap: `0x${hex('ab')}`,
      owner: user.address,
    });
    const signature = await user.signTypedData(sponsorDomain(), SPONSOR_ACTION_TYPES, message);
    expect(recoverSponsorActionSigner(message, signature)).toBe(user.address);
    const used = new Set<string>();
    const opts = {
      expectedAction: 'open-swap' as const,
      network: 'stagenet',
      expectedSwap: hex('ab'),
      payload,
      now: 1_999_999_900,
      maxTtlSeconds: 600,
      consumeNonce: (n: string) => (used.has(n) ? ('used' as const) : (used.add(n), 'ok' as const)),
    };
    expect(verifySponsorAction({ message, signature }, opts).ok).toBe(true);
    expect(verifySponsorAction({ message, signature }, opts)).toMatchObject({ ok: false, code: 'replayed' });
  });
});

describe('the shared schemas', () => {
  it('parse the open request strictly (lowercase hex without 0x, positive decimal amounts)', () => {
    const user = Wallet.createRandom();
    const base = { swap: `0x${hex('AB')}`, payload: payloadFor(user.address), auth: { message: {}, signature: '0x' } };
    expect(OpenSwapRequestSchema.safeParse(base).success).toBe(false); // the auth is malformed
    const ok = OpenSwapRequestSchema.shape.payload.safeParse(base.payload);
    expect(ok.success).toBe(true);
    expect(OpenSwapRequestSchema.shape.swap.parse(`0x${hex('AB')}`)).toBe(hex('ab'));
    for (const bad of [
      { ...base.payload, offerId: `0x${hex('9e')}` },
      { ...base.payload, pay: { colour: hex('5E'), amount: '1' } },
      { ...base.payload, pay: { colour: hex('5e'), amount: '0' } },
      { ...base.payload, pay: { colour: hex('5e'), amount: '1.5' } },
      { ...base.payload, extra: true },
    ]) {
      expect(OpenSwapRequestSchema.shape.payload.safeParse(bad).success).toBe(false);
    }
  });

  it('parse the prove request per purpose, and the take report', () => {
    expect(ProveRequestSchema.safeParse({ purpose: 'take', tx: 'ab' }).success).toBe(true);
    expect(ProveRequestSchema.safeParse({ purpose: 'take', tx: 'ab', coinNonce: hex('11') }).success).toBe(false);
    expect(ProveRequestSchema.safeParse({ purpose: 'withdraw', tx: 'ab' }).success).toBe(false);
    expect(
      ProveRequestSchema.safeParse({ purpose: 'withdraw', tx: 'ab', coinNonce: hex('11'), evmNonce: '9', kind: 'swap' })
        .success,
    ).toBe(true);
    expect(
      ProveRequestSchema.safeParse({ purpose: 'withdraw', tx: 'abc', coinNonce: hex('11'), evmNonce: '9' }).success,
    ).toBe(false);
    expect(TakeReportSchema.safeParse({ outcome: 'taken', takeTx: hex('cd') }).success).toBe(true);
    expect(TakeReportSchema.safeParse({ outcome: 'not-available' }).success).toBe(true);
    expect(TakeReportSchema.safeParse({ outcome: 'taken' }).success).toBe(false);
  });
});

describe('SponsorClient', () => {
  const fakeFetch = (routes: Record<string, { status: number; body: unknown }>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const key = `${init.method ?? 'GET'} ${new URL(url).pathname}`;
      const r = routes[key];
      if (!r) return new Response('{"error":{"code":"not-found","message":"no such route"}}', { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status });
    };
    return { f, calls };
  };

  it('sends the bearer token and JSON, and parses the answers', async () => {
    const { f, calls } = fakeFetch({
      [`POST /v1/swaps/${hex('ab')}/prove`]: { status: 200, body: { tx: 'beef' } },
      [`GET /v1/swaps/${hex('ab')}/withdraw-params`]: {
        status: 200,
        body: {
          kind: 'swap',
          colour: hex('e5'),
          amount: '1000000',
          erc20Address: `0x${'1c'.repeat(20)}`,
          dest: `0x${'48'.repeat(20)}`,
          refundRecipient: hex('6b'),
          gas: { gasLimit: '100000', maxFeePerGas: '10000000000', maxPriorityFeePerGas: '1000000000', keyVersion: '1' },
          evmNonce: '9',
          vaultAddress: hex('77'),
        },
      },
    });
    const c = new SponsorClient({ baseUrl: 'https://sponsor.example/', fetch: f });
    expect(await c.prove(hex('ab'), 'tok'.repeat(15), { purpose: 'take', tx: 'ab' })).toBe('beef');
    expect(calls[0]!.url).toBe(`https://sponsor.example/v1/swaps/${hex('ab')}/prove`);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${'tok'.repeat(15)}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ purpose: 'take', tx: 'ab' });
    const p = await c.withdrawParams(hex('ab'), 't'.repeat(43), 'swap');
    expect(p.evmNonce).toBe('9');
    expect(calls[1]!.url).toMatch(/withdraw-params\?kind=swap$/);
  });

  it('turns the sponsor’s error into a SponsorApiError with its code and detail', async () => {
    const { f } = fakeFetch({
      [`POST /v1/swaps/${hex('ab')}/prove`]: {
        status: 422,
        body: { error: { code: 'invalid-tx', message: 'no', detail: 'wrong-offer' } },
      },
    });
    const c = new SponsorClient({ baseUrl: 'https://sponsor.example', fetch: f });
    const e = await c.prove(hex('ab'), 't'.repeat(43), { purpose: 'take', tx: 'ab' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SponsorApiError);
    expect(e).toMatchObject({ status: 422, code: 'invalid-tx', detail: 'wrong-offer' });
    await expect(c.swap(hex('cd'), 't'.repeat(43))).rejects.toMatchObject({ status: 404, code: 'not-found' });
  });
});

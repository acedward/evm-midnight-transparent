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

  const view = {
    swapId: hex('ab'),
    state: 'depositing',
    evmAddress: `0x${'48'.repeat(20)}`,
    offerId: hex('9e'),
    pay: { colour: hex('5e'), amount: '104166667', symbol: 'stkA', erc20Address: `0x${'2a'.repeat(20)}`, decimals: 6 },
    receive: {
      colour: hex('e5'),
      amount: '1000000',
      symbol: 'USDC',
      erc20Address: `0x${'1c'.repeat(20)}`,
      decimals: 6,
    },
    tempCoinPk: hex('6b'),
    depositAddress: `0x${'fa'.repeat(20)}`,
    erc20Address: `0x${'2a'.repeat(20)}`,
    amount: '104166667',
    sweepGas: {
      gasLimit: '65000',
      maxFeePerGas: '2500000000',
      maxPriorityFeePerGas: '500000000',
      ethWei: '162500000000000',
    },
    deposit: { stage: 'started', stages: [{ stage: 'started', at: 1_790_000_000 }], requestId: hex('e3'), attempts: 1 },
    takeTx: null,
    withdraw: null,
    withdrawals: [],
    createdAt: 1_790_000_000,
    updatedAt: 1_790_000_001,
  };

  it('sends the bearer token, and reads the swap from its {swap} envelope (as the sponsor serves it)', async () => {
    const { f, calls } = fakeFetch({
      [`GET /v1/swaps/${hex('ab')}`]: { status: 200, body: { swap: view } },
      ['GET /v1/auth/nonce']: {
        status: 200,
        body: { nonce: `0x${hex('0d')}`, expiresAt: 1_790_000_600, maxTtlSeconds: 600 },
      },
    });
    const c = new SponsorClient({ baseUrl: 'https://sponsor.example/', fetch: f });
    const v = await c.swap(hex('ab'), 'tok'.repeat(15));
    expect(v).toMatchObject({ state: 'depositing', deposit: { requestId: hex('e3') }, takeTx: null });
    expect(calls[0]!.url).toBe(`https://sponsor.example/v1/swaps/${hex('ab')}`);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${'tok'.repeat(15)}`);
    expect((await c.nonce()).maxTtlSeconds).toBe(600);
    // A bare view (no envelope) is not the sponsor's wire.
    const bare = fakeFetch({ [`GET /v1/swaps/${hex('ab')}`]: { status: 200, body: view } });
    await expect(
      new SponsorClient({ baseUrl: 'https://s.example', fetch: bare.f }).swap(hex('ab'), 't'),
    ).rejects.toThrow();
  });

  it('turns the sponsor’s error into a SponsorApiError with its code, detail and rebuild flag', async () => {
    const { f } = fakeFetch({
      [`GET /v1/swaps/${hex('ab')}`]: {
        status: 409,
        body: { error: { code: 'stale-vault-state', message: 'rebuild', detail: 'moved' } },
      },
    });
    const c = new SponsorClient({ baseUrl: 'https://sponsor.example', fetch: f });
    const e = await c.swap(hex('ab'), 't'.repeat(43)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SponsorApiError);
    expect(e).toMatchObject({ status: 409, code: 'stale-vault-state', detail: 'moved', rebuild: true });
    const nf = await c.swap(hex('cd'), 't'.repeat(43)).catch((x: unknown) => x);
    expect(nf).toMatchObject({ status: 404, code: 'not-found', rebuild: false });
  });
});

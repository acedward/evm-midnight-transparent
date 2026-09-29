// The sponsor API client (the real one P3 points at the real sponsor) against the mock sponsor: the
// open-swap SponsorAction as signed, the checks the sponsor makes (a tampered body, a replayed or
// unknown nonce, another signer, a missing or wrong bearer token), and how errors reach the page.
// Also: the site config's mock block.

import { payloadHash } from '@evm-midnight-transparent/core';
import { afterEach, describe, expect, it } from 'vitest';

import { loadSiteConfig } from '../src/config.js';
import type { MockEnvironment } from '../src/swap/mock/index.js';
import {
  HttpSponsorApi,
  type OpenSwapPayload,
  SponsorError,
  openSwapMessage,
  signOpenSwap,
} from '../src/swap/sponsor-client.js';
import { askOffer, mockEnv, network, testSigner } from './swap-fixtures.js';

let env: MockEnvironment;
afterEach(() => env?.stop());

const H = (c: string) => c.repeat(64);

async function setup() {
  env = mockEnv();
  const api = new HttpSponsorApi('https://sponsor.mock.invalid', { fetch: env.sponsorFetch });
  const offer = await askOffer(env);
  const signer = testSigner();
  const payload: OpenSwapPayload = {
    offerId: offer.offerId,
    evmAddress: signer.address,
    pay: { colour: offer.pay.token.midnightColour, amount: offer.pay.amount.toString() },
    receive: { colour: offer.receive.token.midnightColour, amount: offer.receive.amount.toString() },
    tempCoinPk: H('c'),
    tempEncPk: H('d'),
  };
  const swapId = `0x${H('5')}`;
  const sign = async (p: OpenSwapPayload = payload, s = signer) => {
    const nonce = await api.nonce();
    const message = openSwapMessage({
      network: 'stagenet',
      swapId,
      payload: p,
      nonce: nonce.nonce,
      expiry: Math.floor(Date.now() / 1000) + 120,
    });
    return signOpenSwap(s, message, network.evm.chainId);
  };
  return { api, payload, swapId, signer, sign };
}

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as SponsorError;
  }
  throw new Error('expected a refusal');
};

describe('the open-swap SponsorAction', () => {
  it('binds the action, network, owner, swap and the exact payload', async () => {
    const { payload, swapId } = await setup();
    const m = openSwapMessage({ network: 'stagenet', swapId, payload, nonce: `0x${H('A')}`, expiry: 123 });
    expect(m).toEqual({
      action: 'open-swap',
      network: 'stagenet',
      owner: payload.evmAddress,
      swap: swapId,
      payloadHash: payloadHash(payload),
      nonce: `0x${H('a')}`,
      expiry: '123',
    });
    expect(() => openSwapMessage({ network: 'stagenet', swapId: H('5'), payload, nonce: '0x', expiry: 1 })).toThrow(
      RangeError,
    );
  });
});

describe('the sponsor client against the mock sponsor', () => {
  it('opens a swap, then reads it with the bearer token only', async () => {
    const { api, payload, swapId, sign } = await setup();
    const opened = await api.openSwap({ swap: swapId, payload, auth: await sign() });
    expect(opened.amount).toBe('1040000');
    expect(opened.sweepGas).toEqual({ gasLimit: '65000', maxFeePerGas: '2500000000', ethWei: '162500000000000' });
    expect((await api.swap(swapId, opened.swapToken)).state).toBe('awaiting_funds');
    const noToken = await refusal(api.swap(swapId, 'x'.repeat(64)));
    expect(noToken).toBeInstanceOf(SponsorError);
    expect([noToken.status, noToken.code]).toEqual([401, 'unauthorised']);
    // A re-open (resume) with the same terms gives a new token and retires the old one.
    const again = await api.openSwap({ swap: swapId, payload, auth: await sign() });
    expect(again.swapToken).not.toBe(opened.swapToken);
    expect((await refusal(api.swap(swapId, opened.swapToken))).status).toBe(401);
    // Other terms for the same swap id are refused.
    const other = { ...payload, tempCoinPk: H('e') };
    expect((await refusal(api.openSwap({ swap: swapId, payload: other, auth: await sign(other) }))).status).toBe(409);
  });

  it('refuses a body the signature does not cover, a replayed nonce, and another signer', async () => {
    const { api, payload, swapId, sign } = await setup();
    const auth = await sign();
    const tampered = await refusal(api.openSwap({ swap: swapId, payload: { ...payload, tempCoinPk: H('e') }, auth }));
    expect([tampered.status, tampered.message]).toEqual([401, 'the signature does not cover this body']);
    await api.openSwap({ swap: swapId, payload, auth });
    const replay = await refusal(api.openSwap({ swap: swapId, payload, auth }));
    expect(replay.message).toBe('unknown or used nonce');
    const mallory = testSigner();
    const forged = await refusal(api.openSwap({ swap: `0x${H('6')}`, payload, auth: await sign(payload, mallory) }));
    expect(forged.status).toBe(401);
  });

  it('reads withdraw-params (the refund recipient as {left}), sends the prove hints, reports the take', async () => {
    const { api, payload, swapId, sign } = await setup();
    const { swapToken } = await api.openSwap({ swap: swapId, payload, auth: await sign() });
    const p = await api.withdrawParams(swapId, swapToken, 'bridge-back');
    expect(p).toEqual({
      kind: 'bridge-back',
      colour: payload.pay.colour,
      amount: 1_040_000n,
      erc20Address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      dest: payload.evmAddress,
      refundRecipient: H('c'),
      gas: { gasLimit: 100_000n, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, keyVersion: 1n },
      evmNonce: 9n,
    });
    // A withdrawal proof whose hints are not the transaction's is refused.
    const tx = Buffer.from(
      JSON.stringify({
        mock: 'emt-tx',
        kind: 'withdraw',
        coinPk: H('c'),
        colour: payload.pay.colour,
        amount: '1040000',
        dest: payload.evmAddress,
        coinNonce: H('1'),
        evmNonce: '9',
      }),
    ).toString('hex');
    await expect(
      api.prove(swapId, swapToken, { purpose: 'withdraw', tx, coinNonce: H('2'), evmNonce: '9' }),
    ).rejects.toThrow(/hints/);
    const stale = await refusal(
      api.prove(swapId, swapToken, { purpose: 'withdraw', tx: tx, coinNonce: H('1'), evmNonce: '8' }),
    );
    expect(stale.code).toBe('refused');
    // The take report answers the swap's view.
    expect((await api.reportTake(swapId, swapToken, { outcome: 'not-available' })).state).toBe('awaiting_funds');
  });

  it('marks the stale answers that mean "rebuild"', () => {
    expect(new SponsorError('x', 409, 'stale-vault-state').rebuild).toBe(true);
    expect(new SponsorError('x', 409, 'stale-evm-nonce').rebuild).toBe(true);
    expect(new SponsorError('x', 409, 'swap-conflict').rebuild).toBe(false);
  });

  it('reads a view with null legs and hashes as absent (L-SPONSOR 4)', async () => {
    const api = new HttpSponsorApi('https://sponsor.invalid', {
      fetch: async () =>
        new Response(
          JSON.stringify({
            swapId: `0x${H('5')}`,
            state: 'minted',
            deposit: null,
            takeTx: null,
            withdraw: null,
            withdrawals: [],
            extra: 1,
          }),
        ),
    });
    expect(await api.swap(`0x${H('5')}`, 't')).toEqual({ swapId: `0x${H('5')}`, state: 'minted' });
  });

  it('surfaces network failures and unreadable answers as SponsorErrors', async () => {
    const down = new HttpSponsorApi('https://sponsor.invalid', {
      fetch: async () => {
        throw new TypeError('offline');
      },
    });
    expect((await refusal(down.nonce())).code).toBe('network');
    const odd = new HttpSponsorApi('https://sponsor.invalid', { fetch: async () => new Response('{"hello":1}') });
    expect((await refusal(odd.nonce())).code).toBe('invalid-response');
    const limited = new HttpSponsorApi('https://sponsor.invalid', {
      fetch: async () => new Response('', { status: 429 }),
    });
    expect((await refusal(limited.nonce())).code).toBe('rate-limited');
    expect(() => new HttpSponsorApi('ftp://x')).toThrow(RangeError);
  });
});

describe('the site config', () => {
  const serve = (body: unknown) => async () => new Response(JSON.stringify(body));
  it('reads the mock block with its defaults, and none without it', async () => {
    const c = await loadSiteConfig(serve({ network: 'stagenet', mock: true }));
    expect(c.mock).toEqual({ stepMs: 1500, scenario: {}, evmWallet: false, book: 'default', persist: true });
    expect((await loadSiteConfig(serve({ network: 'stagenet' }))).mock).toBeUndefined();
    await expect(loadSiteConfig(serve({ mock: { stepMs: 'fast' } }))).rejects.toThrow(/mock settings/);
    await expect(loadSiteConfig(serve({ mock: { secret: 1 } }))).rejects.toThrow(/mock settings/);
  });
});

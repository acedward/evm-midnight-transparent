// Open-swap authorisation (one EIP-712 SponsorAction per swap) and the bearer token every other
// swap route requires. Every state-changing route is enumerated from the app, so a new one that is
// not covered here fails the first test.

import { SWAP_PATHS } from '@evm-midnight-transparent/core';
import { describe, expect, it } from 'vitest';

import { STATE_CHANGING_ROUTES } from '../src/app.js';
import {
  FakeSponsor,
  bidSwap,
  get,
  harness,
  hex32,
  newWallet,
  openBody,
  openSwap,
  post,
  testConfig,
} from './harness.js';

const expectError = async (res: Response, status: number, code: string, detail?: string) => {
  expect(res.status).toBe(status);
  const body = (await res.json()) as { error: { code: string; detail?: string } };
  expect(body.error.code).toBe(code);
  if (detail !== undefined) expect(body.error.detail).toBe(detail);
};

describe('the sponsor routes', () => {
  it('has exactly the four state-changing routes it declares, and no action or job routes', () => {
    const { app } = harness();
    const writes = app.routes.filter((r) => !['GET', 'ALL', 'OPTIONS', 'HEAD'].includes(r.method));
    expect([...new Set(writes.map((r) => `${r.method} ${r.path}`))].sort()).toEqual(
      STATE_CHANGING_ROUTES.map((r) => `${r.method} ${r.path}`).sort(),
    );
    expect(app.routes.some((r) => r.path.startsWith('/v1/actions') || r.path.startsWith('/v1/jobs'))).toBe(false);
  });

  it('refuses every bearer route without a token, with a wrong token, and with another swap’s token', async () => {
    const h = harness();
    const a = bidSwap(h, newWallet(), 'a');
    const b = bidSwap(h, newWallet(), 'b');
    const oa = await openSwap(h, a);
    const ob = await openSwap(h, b);
    for (const r of STATE_CHANGING_ROUTES.filter((x) => x.auth === 'bearer')) {
      const path = r.path.replace(':id', a.swapId);
      await expectError(await post(h, path, {}), 401, 'unauthorised');
      await expectError(await post(h, path, {}, 'x'.repeat(43)), 401, 'unauthorised');
      await expectError(await post(h, path, {}, ob.swapToken), 401, 'unauthorised');
    }
    await expectError(await get(h, SWAP_PATHS.swap(a.swapId)), 401, 'unauthorised');
    await expectError(await get(h, SWAP_PATHS.swap(a.swapId), ob.swapToken), 401, 'unauthorised');
    // an unknown swap answers exactly like a wrong token (existence is not revealed)
    await expectError(await get(h, SWAP_PATHS.swap(hex32('nope')), oa.swapToken), 401, 'unauthorised');
    expect((await get(h, SWAP_PATHS.swap(a.swapId), oa.swapToken)).status).toBe(200);
  });
});

describe('POST /v1/swaps: the open-swap signature', () => {
  it('opens with one valid signature, and answers the deposit address, sweep gas, ERC20 and amount', async () => {
    const h = harness();
    const s = bidSwap(h);
    const res = await post(h, SWAP_PATHS.swaps, await openBody(h, s));
    expect(res.status).toBe(201);
    const o = (await res.json()) as {
      swapToken: string;
      depositAddress: string;
      erc20Address: string;
      amount: string;
      resumed: boolean;
      sweepGas: { gasLimit: string; maxFeePerGas: string; ethWei: string };
      swap: { state: string };
    };
    expect(o.swapToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(o.depositAddress).toBe(h.vault.depositAddress(s.payload.tempCoinPk));
    expect(o.erc20Address).toBe('0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52');
    expect(o.amount).toBe('104166667');
    expect(o.resumed).toBe(false);
    expect(o.sweepGas).toMatchObject({ gasLimit: '65000', maxFeePerGas: '2500000000', ethWei: '162500000000000' });
    expect(o.swap.state).toBe('awaiting_funds');
    // the token is stored as a hash only
    expect(JSON.stringify(h.store.all())).not.toContain(o.swapToken);
  });

  it('refuses a bad signature (another signer, or a signature over something else)', async () => {
    const h = harness();
    const s = bidSwap(h);
    await expectError(
      await post(h, SWAP_PATHS.swaps, await openBody(h, s, { signer: newWallet() })),
      401,
      'unauthorised',
      'wrong-signer',
    );
    const body = await openBody(h, s);
    body.auth.signature = `0x${'11'.repeat(65)}`;
    await expectError(await post(h, SWAP_PATHS.swaps, body), 401, 'unauthorised', 'bad-signature');
    await expectError(
      await post(h, SWAP_PATHS.swaps, await openBody(h, s, { signedPayload: { ...s.payload, offerId: hex32('x') } })),
      401,
      'unauthorised',
      'payload-mismatch',
    );
    await expectError(
      await post(h, SWAP_PATHS.swaps, await openBody(h, s, { signedSwap: hex32('other') })),
      401,
      'unauthorised',
      'wrong-swap',
    );
    await expectError(
      await post(h, SWAP_PATHS.swaps, await openBody(h, s, { action: 'bridge-withdraw' })),
      401,
      'unauthorised',
      'wrong-action',
    );
    await expectError(
      await post(h, SWAP_PATHS.swaps, await openBody(h, s, { network: 'undeployed' })),
      401,
      'unauthorised',
      'wrong-network',
    );
    expect(h.store.all()).toHaveLength(0);
  });

  it('refuses a replayed nonce and a nonce the sponsor never issued', async () => {
    const h = harness();
    const s = bidSwap(h);
    const body = await openBody(h, s);
    expect((await post(h, SWAP_PATHS.swaps, body)).status).toBe(201);
    await expectError(await post(h, SWAP_PATHS.swaps, body), 401, 'unauthorised', 'replayed');
    await expectError(
      await post(h, SWAP_PATHS.swaps, await openBody(h, s, { nonce: `0x${'42'.repeat(32)}` })),
      401,
      'unauthorised',
      'unknown-nonce',
    );
  });

  it('refuses an expired signature, and one that expires too far ahead', async () => {
    const h = harness();
    const s = bidSwap(h);
    const nowS = Math.floor(h.now.ms / 1000);
    await expectError(
      await post(h, SWAP_PATHS.swaps, await openBody(h, s, { expiry: nowS - 5 })),
      401,
      'unauthorised',
      'expired',
    );
    await expectError(
      await post(h, SWAP_PATHS.swaps, await openBody(h, s, { expiry: nowS + 3600 })),
      401,
      'unauthorised',
      'expiry-too-far',
    );
  });

  it('refuses an EVM address in the payload that is not the signer', async () => {
    const h = harness();
    const s = bidSwap(h);
    s.payload.evmAddress = newWallet().address;
    await expectError(await post(h, SWAP_PATHS.swaps, await openBody(h, s)), 401, 'unauthorised', 'wrong-signer');
  });

  it('refuses malformed bodies: wrong hex case, 0x colours, zero amounts, extra fields', async () => {
    const h = harness();
    const s = bidSwap(h);
    const good = await openBody(h, s);
    for (const bad of [
      { ...good, payload: { ...good.payload, tempCoinPk: good.payload.tempCoinPk.toUpperCase() } },
      { ...good, payload: { ...good.payload, pay: { ...good.payload.pay, colour: `0x${good.payload.pay.colour}` } } },
      { ...good, payload: { ...good.payload, pay: { ...good.payload.pay, amount: '0' } } },
      { ...good, payload: { ...good.payload, extra: 1 } },
      { ...good, swap: 'zz' },
      { swap: good.swap, payload: good.payload },
    ]) {
      await expectError(await post(h, SWAP_PATHS.swaps, bad), 400, 'bad-request');
    }
    await expectError(await post(h, SWAP_PATHS.swaps, '{not json'), 400, 'bad-request');
  });

  it('refuses a new swap while the sponsor cannot pay, WITHOUT spending the nonce', async () => {
    const h = harness();
    const s = bidSwap(h);
    const body = await openBody(h, s);
    h.sponsor.current = { configured: true, state: 'syncing', synced: false, dustSpecks: null };
    await expectError(await post(h, SWAP_PATHS.swaps, body), 503, 'sponsor-unavailable');
    h.sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 1n };
    await expectError(await post(h, SWAP_PATHS.swaps, body), 503, 'sponsor-low');
    h.sponsor.current = new FakeSponsor().current;
    expect((await post(h, SWAP_PATHS.swaps, body)).status).toBe(201);
  });

  it('re-open (resume): same swap, owner, terms and keys -> a new token, the old one stops working', async () => {
    const h = harness();
    const s = bidSwap(h);
    const first = await openSwap(h, s);
    // the offer may be gone by now: a re-open does not check it
    h.offers.offers.clear();
    // and the sponsor may be syncing: a re-open spends nothing
    h.sponsor.current = { configured: true, state: 'syncing', synced: false, dustSpecks: null };
    const res = await post(h, SWAP_PATHS.swaps, await openBody(h, s));
    expect(res.status).toBe(200);
    const again = (await res.json()) as { swapToken: string; resumed: boolean; depositAddress: string };
    expect(again.resumed).toBe(true);
    expect(again.depositAddress).toBe(first.depositAddress);
    expect(again.swapToken).not.toBe(first.swapToken);
    await expectError(await get(h, SWAP_PATHS.swap(s.swapId), first.swapToken), 401, 'unauthorised');
    expect((await get(h, SWAP_PATHS.swap(s.swapId), again.swapToken)).status).toBe(200);
  });

  it('refuses a re-open with other terms, keys or owner (409), and another swap on the same temporary wallet', async () => {
    const h = harness();
    const s = bidSwap(h);
    await openSwap(h, s);
    const otherKeys = { ...s, payload: { ...s.payload, tempEncPk: hex32('other-enc') } };
    await expectError(await post(h, SWAP_PATHS.swaps, await openBody(h, otherKeys)), 409, 'swap-conflict');
    const thief = newWallet();
    const stolen = { user: thief, swapId: s.swapId, payload: { ...s.payload, evmAddress: thief.address } };
    await expectError(await post(h, SWAP_PATHS.swaps, await openBody(h, stolen)), 409, 'swap-conflict');
    const sameWallet = { ...s, swapId: hex32('second') };
    await expectError(
      await post(h, SWAP_PATHS.swaps, await openBody(h, sameWallet)),
      409,
      'swap-conflict',
      'coin-key-in-use',
    );
  });

  it('rate-limits opens per client address and per EVM address', async () => {
    const h = harness({
      config: testConfig({ RATE_LIMIT_OPENS_PER_OWNER_PER_MIN: '2', SWAP_MAX_ACTIVE_PER_OWNER: '50' }),
    });
    const user = newWallet();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await post(h, SWAP_PATHS.swaps, await openBody(h, bidSwap(h, user, `r${i}`)))).status);
    }
    expect(statuses).toEqual([201, 201, 429]);
    const h2 = harness({ config: testConfig({ RATE_LIMIT_OPENS_PER_MIN: '2' }) });
    const perIp: number[] = [];
    for (let i = 0; i < 3; i++) perIp.push((await post(h2, SWAP_PATHS.swaps, {})).status);
    expect(perIp).toEqual([400, 400, 429]);
  });

  it('limits the swaps in progress per EVM address', async () => {
    const h = harness({ config: testConfig({ SWAP_MAX_ACTIVE_PER_OWNER: '2' }) });
    const user = newWallet();
    await openSwap(h, bidSwap(h, user, 'm1'));
    await openSwap(h, bidSwap(h, user, 'm2'));
    await expectError(
      await post(h, SWAP_PATHS.swaps, await openBody(h, bidSwap(h, user, 'm3'))),
      429,
      'too-many-swaps',
    );
  });
});

describe('reads', () => {
  it('serves health on /health and /v1/health, rate-limited in its own bucket', async () => {
    const h = harness({ config: testConfig({ RATE_LIMIT_HEALTH_PER_MIN: '3' }) });
    const statuses = [];
    for (let i = 0; i < 2; i++) statuses.push((await h.app.request('/health')).status);
    for (let i = 0; i < 2; i++) statuses.push((await h.app.request('/v1/health')).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('serves the public config: network, app name, EIP-712 domains, vault, tokens, batcher', async () => {
    const h = harness();
    const cfg = (await (await h.app.request('/v1/config')).json()) as Record<string, unknown> & {
      eip712: { sponsorDomain: { name: string }; swapKeyDomain: { name: string } };
      tokens: unknown[];
    };
    expect(cfg).toMatchObject({ network: 'stagenet', chainId: 11155111, appName: 'EVM Midnight Swap' });
    expect(cfg.eip712.sponsorDomain.name).toBe('EVM Midnight Swap Sponsor');
    expect(cfg.eip712.swapKeyDomain.name).toBe('EVM Midnight Swap');
    expect(cfg.tokens).toHaveLength(8);
    expect(JSON.stringify(cfg)).not.toMatch(/seed|secret|rpc/i);
  });

  it('serves nonces uncached and rate-limited; 404s unknown routes', async () => {
    const h = harness();
    const r = await h.app.request('/v1/auth/nonce');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const statuses = [];
    for (let i = 0; i < h.config.limits.noncesPerMinute + 1; i++)
      statuses.push((await h.app.request('/v1/auth/nonce')).status);
    expect(statuses[statuses.length - 1]).toBe(429);
    expect((await h.app.request('/v1/actions/open-swap', { method: 'POST' })).status).toBe(404);
    expect((await h.app.request('/nope')).status).toBe(404);
  });

  it('never logs a request body or a token', async () => {
    const h = harness();
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    await get(h, SWAP_PATHS.swap(s.swapId), o.swapToken);
    const logs = h.log.lines.join('\n');
    expect(logs).not.toContain(o.swapToken);
    expect(logs).not.toContain(s.payload.tempEncPk);
  });
});

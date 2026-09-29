// Every state-changing route rejects unsigned or wrongly signed calls (copied from MN Bank's relay
// tests, acedward/passport-evm-dapp @ 911647b).
// The route list is taken from the app itself, so a new state-changing route that is not
// covered here fails the first test.

import { describe, expect, it } from 'vitest';
import { SPONSOR_ACTIONS } from '@evm-midnight-transparent/core';

import { STATE_CHANGING_ROUTES } from '../src/app.js';
import { SWAP, FakeSponsor, harness, newWallet, post, samplePayload, signedBody, testConfig } from './harness.js';

describe('the sponsor routes', () => {
  it('has exactly one state-changing route, POST /v1/actions/:action, and it covers every action', () => {
    const { app } = harness();
    const writes = app.routes.filter((r) => !['GET', 'ALL', 'OPTIONS', 'HEAD'].includes(r.method));
    // one entry per handler (the body-size limit, then the route), so compare the distinct routes
    expect([...new Set(writes.map((r) => `${r.method} ${r.path}`))]).toEqual(['POST /v1/actions/:action']);
    expect(STATE_CHANGING_ROUTES.map((r) => r.action)).toEqual([...SPONSOR_ACTIONS]);
  });
});

describe.each(SPONSOR_ACTIONS)('POST /v1/actions/%s', (action) => {
  const expect401 = async (res: Response, detail: string) => {
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; detail?: string } };
    expect(body.error.code).toBe('unauthorised');
    expect(body.error.detail).toBe(detail);
  };

  it('refuses an unsigned call', async () => {
    const h = harness();
    const def = h.catalogue.get(action)!;
    await expect401(
      await post(h, action, { ...(def.requiresSwap ? { swap: SWAP } : {}), payload: samplePayload(action) }),
      'malformed',
    );
    expect(h.queue.stats().jobs).toBe(0);
  });

  it('refuses a call signed by someone other than the owner', async () => {
    const h = harness();
    const owner = newWallet();
    const body = await signedBody(h, action, newWallet(), { owner: owner.address });
    await expect401(await post(h, action, body), 'wrong-signer');
    expect(h.queue.stats().jobs).toBe(0);
  });

  it('refuses an expired call', async () => {
    const h = harness();
    await expect401(
      await post(h, action, await signedBody(h, action, newWallet(), { expiry: Math.floor(Date.now() / 1000) - 5 })),
      'expired',
    );
  });

  it('refuses a replayed call', async () => {
    const h = harness();
    const body = await signedBody(h, action, newWallet());
    expect((await post(h, action, body)).status).toBe(202);
    await expect401(await post(h, action, body), 'replayed');
    expect(h.queue.stats().jobs).toBe(1);
  });

  it('refuses a nonce the sponsor never issued', async () => {
    const h = harness();
    await expect401(
      await post(h, action, await signedBody(h, action, newWallet(), { nonce: `0x${'42'.repeat(32)}` })),
      'unknown-nonce',
    );
  });

  it('refuses a signature for another action, or another network', async () => {
    const h = harness();
    const other = SPONSOR_ACTIONS.find((a) => a !== action)!;
    await expect401(
      await post(h, action, await signedBody(h, action, newWallet(), { signedAction: other })),
      'wrong-action',
    );
    await expect401(
      await post(h, action, await signedBody(h, action, newWallet(), { network: 'stagenet' })),
      'wrong-network',
    );
  });

  it('refuses a body the signature does not cover', async () => {
    const h = harness();
    const body = await signedBody(h, action, newWallet());
    const tampered = { ...body, payload: { ...body.payload, extra: '1' } };
    await expect401(await post(h, action, tampered), 'payload-mismatch');
    await expect401(await post(h, action, { ...body, swap: '22'.repeat(32) }), 'wrong-swap');
  });

  it('accepts a correctly signed call, queues it, and the job can be resumed by its request id', async () => {
    const h = harness();
    const signer = newWallet();
    const res = await post(h, action, await signedBody(h, action, signer));
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: { requestId: string; action: string } };
    expect(job.action).toBe(action);
    await h.queue.settled(job.requestId);
    const again = await h.app.request(`/v1/jobs/${job.requestId}`);
    expect(again.status).toBe(200);
    const view = ((await again.json()) as { job: { state: string; error?: { code: string } } }).job;
    // P0: every executor is a stub that the sponsor lane replaces
    expect(view.state).toBe('failed');
    expect(view.error?.code).toBe('not-implemented');
  });
});

describe('action request checks', () => {
  it('refuses unknown actions, non-JSON, bad shapes and missing swaps', async () => {
    const h = harness();
    expect((await post(h, 'mint', {})).status).toBe(404);
    const raw = await h.app.request('/v1/actions/bridge-withdraw', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(raw.status).toBe(400);
    expect((await post(h, 'bridge-withdraw', { swap: SWAP, payload: 'x' })).status).toBe(400);
    expect((await post(h, 'bridge-withdraw', { payload: {} })).status).toBe(400);
    expect((await post(h, 'bridge-withdraw', { swap: 'zz', payload: {} })).status).toBe(400);
  });

  it('refuses spending actions while the sponsor is not synced or is low, without consuming the nonce', async () => {
    const sponsor = new FakeSponsor({ configured: true, state: 'syncing', synced: false, dustSpecks: null });
    const h = harness({ sponsor });
    const body = await signedBody(h, 'swap-open', newWallet());
    const res = await post(h, 'swap-open', body);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('sponsor-unavailable');
    sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 1n };
    expect(((await (await post(h, 'swap-open', body)).json()) as { error: { code: string } }).error.code).toBe(
      'sponsor-low',
    );
    sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 10n ** 20n };
    expect((await post(h, 'swap-open', body)).status).toBe(202);
  });

  it('refuses a body over the size limit', async () => {
    const h = harness();
    const big = { payload: { blob: 'x'.repeat(h.config.limits.maxBodyBytes + 10) } };
    expect((await post(h, 'bridge-withdraw', big)).status).toBe(413);
  });

  it('rate-limits actions per client address and per owner', async () => {
    const h = harness();
    const signer = newWallet();
    const statuses: number[] = [];
    for (let i = 0; i < h.config.limits.actionsPerOwnerPerMinute + 1; i++) {
      statuses.push((await post(h, 'swap-open', await signedBody(h, 'swap-open', signer))).status);
    }
    expect(statuses.slice(0, -1).every((s) => s === 202)).toBe(true);
    const last = statuses[statuses.length - 1];
    expect(last).toBe(429);
    const perIp = [];
    for (let i = 0; i < h.config.limits.actionsPerMinute + 2; i++)
      perIp.push((await post(h, 'bridge-withdraw', { payload: {} })).status);
    expect(perIp).toContain(429);
  });

  it('rate-limits nonces, and serves them uncached', async () => {
    const h = harness();
    const r = await h.app.request('/v1/auth/nonce');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const statuses = [];
    for (let i = 0; i < h.config.limits.noncesPerMinute + 1; i++)
      statuses.push((await h.app.request('/v1/auth/nonce')).status);
    expect(statuses[statuses.length - 1]).toBe(429);
  });
});

describe('reads', () => {
  it('rate-limits /health per client address in its own bucket', async () => {
    const h = harness({ config: testConfig({ RATE_LIMIT_HEALTH_PER_MIN: '3' }) });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await h.app.request('/health')).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    // the read bucket is separate: jobs and the queue still answer
    expect((await h.app.request('/v1/queue')).status).toBe(200);
  });

  it('serves health, config, queue and 404s', async () => {
    const h = harness();
    expect((await h.app.request('/health')).status).toBe(200);
    const cfg = (await (await h.app.request('/v1/config')).json()) as { network: string; chainId: number };
    expect(cfg).toMatchObject({ network: 'undeployed', chainId: 11155111 });
    expect((await h.app.request('/v1/queue')).status).toBe(200);
    expect((await h.app.request('/v1/jobs/zz')).status).toBe(400);
    expect((await h.app.request(`/v1/jobs/${'0'.repeat(32)}`)).status).toBe(404);
    expect((await h.app.request('/nope')).status).toBe(404);
  });

  it('has no account routes (there are no accounts here)', async () => {
    const h = harness();
    expect((await h.app.request(`/v1/accounts/${SWAP}/state`)).status).toBe(404);
    expect((await h.app.request('/v1/bridge/quote')).status).toBe(404);
  });

  it('never logs a request body', async () => {
    const h = harness();
    await post(h, 'swap-open', await signedBody(h, 'swap-open', newWallet()));
    expect(h.log.lines.join('\n')).not.toContain('bb'.repeat(32));
  });
});

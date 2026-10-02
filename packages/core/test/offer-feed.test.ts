// The live offer feed against a mock kernel over real HTTP: the whole book is read with no token
// filter, an offer event refreshes it, a stopped kernel is "exchange unavailable" (and recovers),
// and a refused stream falls back to polling.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KernelClient, OfferFeed, stagenetRegistry } from '../src/index.js';
import { COLOUR, leg, offerRow } from './fixtures/kernel/book.js';
import { startMockKernel, type MockKernelServer } from './mock-kernel-server.js';

const registry = stagenetRegistry();
let kernel: MockKernelServer;
let feed: OfferFeed | null = null;

const newFeed = (opts: { useStream?: boolean } = {}) => {
  const client = new KernelClient({ baseUrl: kernel.url, timeoutMs: 300, retries: 0, backoffMs: 20, random: () => 1 });
  feed = new OfferFeed({
    client,
    registry,
    useStream: opts.useStream ?? true,
    pollMs: 150,
    safetyRefreshMs: 400,
    debounceMs: 30,
    reconnectMs: 100,
    maxReconnectMs: 200,
  });
  return feed;
};

async function until<T>(get: () => T | undefined | false | null, ms = 5_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ready = (f: OfferFeed) => {
  const s = f.getState();
  return s.status === 'ready' ? s : undefined;
};
const count = (f: OfferFeed) => ready(f)?.snapshot.offers.length ?? -1;

beforeEach(async () => {
  kernel = await startMockKernel();
});
afterEach(async () => {
  feed?.stop();
  feed = null;
  await kernel.close();
});

describe('the offer feed', () => {
  it('reads the whole book once per refresh, with no token filter', async () => {
    const f = newFeed({ useStream: false });
    f.start();
    const s = await until(() => ready(f));
    expect(f.refreshes).toBe(1);
    expect(s.snapshot.offers).toHaveLength(7);
    expect(s).toMatchObject({ complete: true, skipped: 0 });
    const offersReqs = kernel.fixture.requests.filter((r) => r.path === '/v1/offers');
    expect(offersReqs).toHaveLength(1);
    expect(offersReqs[0]!.query.get('token')).toBeNull();
    // One refresh is one book page: no pairs, no chart stats, never /v1/prices.
    expect([...kernel.log]).toEqual(['/v1/offers']);
  });

  it('follows the offer stream: a new offer refreshes the book, a consumed one leaves it', async () => {
    const f = newFeed();
    f.start();
    await until(() => ready(f) && f.getState().stream === 'live');
    const before = f.refreshes;
    // A new offer: 1 wUSDC for 101 wStkC.
    kernel.fixture.book.unshift(offerRow(50, [leg(COLOUR.wUSDC, 1_000_000)], [leg(COLOUR.wStkC, 101_000_000)]));
    kernel.broadcast({ type: 'offer_indexed', offerId: 50, offerHash: 'ab'.repeat(32), blockHeight: '900050' });
    const s = await until(() => {
      const r = ready(f);
      return r && f.refreshes > before && r.snapshot.offers.length === 8 ? r : undefined;
    });
    expect(s.snapshot.offers[0]).toMatchObject({ pay: { amount: 101_000_000n }, receive: { amount: 1_000_000n } });
    kernel.fixture.book = kernel.fixture.book.filter((o) => o.offerId !== offerRow(50, [], []).offerId);
    kernel.broadcast({ type: 'offer_consumed', offerId: 50 });
    await until(() => count(f) === 7);
  });

  it('a stopped kernel is "exchange unavailable" without stale offers, and it recovers', async () => {
    const f = newFeed();
    f.start();
    await until(() => ready(f));
    await kernel.stop();
    const down = await until(() => {
      const s = f.getState();
      return s.status === 'unavailable' ? s : undefined;
    });
    expect(down.reason).toBe('the exchange did not answer');
    expect(down.lastUpdatedAt).not.toBeNull();
    expect('snapshot' in down).toBe(false);
    expect(f.getState().stream).not.toBe('live');
    await kernel.resume();
    await until(() => ready(f) && f.getState().stream === 'live');
  });

  it('polls when the stream is refused (503 SSE_CAPACITY)', async () => {
    kernel.fault('/v1/offers/stream', { status: 503, headers: { 'retry-after': '60' } }, 1000);
    const f = newFeed();
    f.start();
    await until(() => ready(f));
    await until(() => f.getState().stream === 'polling');
    const n = f.refreshes;
    await until(() => f.refreshes >= n + 2); // the 150 ms poll keeps it fresh
    kernel.fixture.book.unshift(offerRow(60, [leg(COLOUR.wUSDC, 2_000_000)], [leg(COLOUR.wStkB, 1_000_000)]));
    await until(() => count(f) === 8);
  });

  it('without the stream at all, polls', async () => {
    const f = newFeed({ useStream: false });
    f.start();
    await until(() => ready(f));
    expect(f.getState().stream).toBe('polling');
    expect(kernel.log).not.toContain('/v1/offers/stream');
  });

  it('stop() ends every request and timer', async () => {
    const f = newFeed();
    f.start();
    await until(() => ready(f) && f.getState().stream === 'live');
    f.stop();
    expect(f.getState().stream).toBe('off');
    const n = kernel.log.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(kernel.log.length).toBe(n);
    await until(() => kernel.streams.size === 0);
  });
});

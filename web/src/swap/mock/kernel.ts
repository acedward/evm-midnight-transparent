// The mock exchange: the offer-files kernel's read API, served from the mock chain as a `fetch`
// implementation for core's real `KernelClient` (the same wire shapes as `ledger-v9` @ 5d46e8d):
//
//   GET /v1/offers                 the live book (one page)
//   GET /v1/offers/stream          server-sent events: `connected`, then offer_indexed / _consumed
//   GET /v1/offers/:id             one offer with its (mock) `swapoffer1…` string; 404 if unknown
//   GET /v1/offers/:id/status      live | consumed | expired | not_found

import { MockChain, type MockLeg, type MockOffer } from './chain.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });

const wireLeg = (l: MockLeg) => ({ token: l.token, amount: l.amount.toString(), type: l.type });

function computed(o: MockOffer) {
  return {
    gives: o.gives.map(wireLeg),
    wants: o.wants.map(wireLeg),
    expiresAt: o.expiresAt,
    inputNullifiers: [o.offerId.split('').reverse().join('')],
    firstSeenAt: o.firstSeenAt,
    status: o.status,
  };
}

const row = (o: MockOffer) => ({
  version: 1,
  offerId: o.offerId,
  blobChars: 24_000,
  blockHeight: String(o.blockHeight),
  computed: computed(o),
});

export interface MockKernelOptions {
  /** Answer every request with this HTTP status (the exchange is down). */
  down?: () => number | null;
}

export function mockKernelFetch(chain: MockChain, options: MockKernelOptions = {}) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const down = options.down?.() ?? null;
    if (down !== null) return json({ error: 'UNAVAILABLE' }, down);
    const path = url.pathname.replace(/\/+$/, '');
    if ((init.method ?? 'GET') !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405);

    if (path === '/v1/offers') return json({ offers: chain.liveOffers().map(row), nextCursor: null });

    if (path === '/v1/offers/stream') {
      const encoder = new TextEncoder();
      let off: (() => void) | undefined;
      let beat: ReturnType<typeof setInterval> | undefined;
      const stop = () => {
        off?.();
        clearInterval(beat);
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const send = (text: string) => {
            try {
              controller.enqueue(encoder.encode(text));
            } catch {
              stop();
            }
          };
          send(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);
          off = chain.subscribe((ev) => send(`data: ${JSON.stringify(ev)}\n\n`));
          beat = setInterval(() => send(': heartbeat\n\n'), 20_000);
          init.signal?.addEventListener(
            'abort',
            () => {
              stop();
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            },
            { once: true },
          );
        },
        cancel: stop,
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    const status = /^\/v1\/offers\/([0-9a-fA-F]{64})\/status$/.exec(path);
    if (status) {
      const o = chain.offer(status[1]!);
      return json({ offerId: status[1]!.toLowerCase(), status: o ? o.status : 'not_found' });
    }

    const one = /^\/v1\/offers\/([0-9a-fA-F]{64})$/.exec(path);
    if (one) {
      const o = chain.offer(one[1]!);
      if (!o) return json({ error: 'NOT_FOUND' }, 404);
      return json({
        offerId: o.offerId,
        offerBech32: MockChain.offerBech32(o.offerId),
        blockHeight: String(o.blockHeight),
        ttlSeconds: String(Math.max(0, Math.floor((Date.parse(o.expiresAt) - Date.now()) / 1000))),
        computed: computed(o),
      });
    }
    return json({ error: 'NOT_FOUND' }, 404);
  };
}

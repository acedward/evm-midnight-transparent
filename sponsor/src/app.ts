// The sponsor's HTTP API (Hono): the swap routes of core swap-api.ts.
//
//   GET  /health, /v1/health                  health (200 ok/degraded, 503 down; its own rate bucket)
//   GET  /v1/config                           public configuration
//   GET  /v1/auth/nonce                       a single-use nonce for the open-swap signature
//   POST /v1/swaps                            open or re-open a swap (EIP-712 SponsorAction "open-swap")
//   GET  /v1/swaps/:id                        the swap                                   (bearer)
//   GET  /v1/swaps/:id/withdraw-params        what startWithdraw needs                   (bearer)
//   POST /v1/swaps/:id/prove                  prove a take or a startWithdraw            (bearer)
//   POST /v1/swaps/:id/withdraw               submit the proven, bound startWithdraw     (bearer)
//   POST /v1/swaps/:id/take                   the take's outcome                         (bearer)
//
// Request bodies and the Authorization header are never logged. Errors are JSON:
// {"error": {"code", "message", "detail"?}}.
//
// The skeleton (error shape, CORS, client address, rate limits, body limit) is MN Bank's relay's
// (acedward/passport-evm-dapp @ 911647b, relay/src/app.ts); L-SPONSOR replaced its action/job routes.

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import {
  OPEN_SWAP_ACTION,
  OpenSwapRequestSchema,
  ProveRequestSchema,
  SWAP_PATHS,
  SwapIdSchema,
  TakeReportSchema,
  WITHDRAW_KINDS,
  WithdrawRequestSchema,
  sponsorDomain,
  startSwapDomain,
  type HealthResponse,
  type NonceResponse,
  type OpenSwapResponse,
  type SwapConfig,
  type WithdrawKind,
} from '@evm-midnight-transparent/core';

import type { NonceStore } from './auth/nonces.js';
import { bearerOf } from './auth/swap-token.js';
import { verifySponsorActionRequest } from './auth/verifiers.js';
import type { SponsorConfig } from './config.js';
import type { Logger } from './log.js';
import { RateLimiter } from './ratelimit.js';
import type { SponsorSession } from './sponsor/session.js';
import { SwapError } from './swaps/errors.js';
import { swapView } from './swaps/model.js';
import type { SwapService } from './swaps/service.js';

export interface AppDeps {
  config: SponsorConfig;
  version: string;
  log: Logger;
  nonces: NonceStore;
  swaps: SwapService;
  sponsor: SponsorSession;
  health: () => Promise<HealthResponse>;
  /** The caller's address for rate limiting (default: the socket's, or X-Forwarded-For's last hop). */
  clientAddress?: (c: Context) => string;
  /** Unix seconds (the signature expiry check). */
  now?: () => number;
}

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 501 | 503;

const apiError = (c: Context, status: ErrorStatus, code: string, message: string, detail?: string) =>
  c.json({ error: { code, message, ...(detail ? { detail } : {}) } }, status);

function defaultClientAddress(trustProxy: boolean): (c: Context) => string {
  return (c) => {
    if (trustProxy) {
      const xff = c.req.header('x-forwarded-for');
      const last = xff
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .pop();
      if (last) return last;
    }
    const server = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
    try {
      return server?.requestIP?.(c.req.raw)?.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };
}

export function createApp(deps: AppDeps): Hono {
  const { config, log, swaps } = deps;
  const clientAddress = deps.clientAddress ?? defaultClientAddress(config.trustProxy);
  const limits = config.limits;
  const readLimiter = new RateLimiter(limits.readsPerMinute);
  const healthLimiter = new RateLimiter(limits.healthPerMinute);
  const nonceLimiter = new RateLimiter(limits.noncesPerMinute);
  const openLimiter = new RateLimiter(limits.opensPerMinute);
  const ownerLimiter = new RateLimiter(limits.opensPerOwnerPerMinute);
  const proveLimiter = new RateLimiter(limits.provesPerMinute);
  const proveSwapLimiter = new RateLimiter(limits.provesPerSwapPerMinute);
  const writeLimiter = new RateLimiter(limits.writesPerMinute);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  const app = new Hono();

  app.use('*', async (c, next) => {
    const t0 = performance.now();
    await next();
    log.info('http', {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Math.round(performance.now() - t0),
    });
  });

  if (config.corsOrigins.length > 0) {
    app.use(
      '*',
      cors({
        origin: config.corsOrigins,
        allowMethods: ['GET', 'POST', 'OPTIONS'],
        allowHeaders: ['content-type', 'authorization'],
        maxAge: 600,
      }),
    );
  }

  const limited = (limiter: RateLimiter, key: string, c: Context) => {
    const r = limiter.take(key);
    if (r.ok) return null;
    c.header('Retry-After', String(r.retryAfterSeconds));
    return apiError(c, 429, 'rate-limited', 'too many requests; try again shortly');
  };

  const bodyLimited = bodyLimit({
    maxSize: limits.maxBodyBytes,
    onError: (c) => apiError(c, 413, 'payload-too-large', 'the request body is too large'),
  });

  const readJson = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      throw new SwapError(400, 'bad-request', 'the body must be JSON');
    }
  };

  /** The swap a bearer route acts on. */
  const authorised = (c: Context) => {
    const id = SwapIdSchema.safeParse(c.req.param('id'));
    if (!id.success) throw new SwapError(400, 'bad-request', 'not a swap id');
    return swaps.authorize(id.data, bearerOf(c.req.header('authorization')));
  };

  // ── reads ──────────────────────────────────────────────────────────────────

  const health = async (c: Context) => {
    const refused = limited(healthLimiter, clientAddress(c), c);
    if (refused) return refused;
    const h = await deps.health();
    return c.json(h, h.status === 'down' ? 503 : 200);
  };
  app.get('/health', health);
  app.get(SWAP_PATHS.health, health);

  app.get(SWAP_PATHS.config, (c) => {
    const n = config.network;
    const body: SwapConfig = {
      network: n.name,
      chainId: n.evm.chainId,
      sponsorVersion: deps.version,
      appName: config.appName,
      eip712: { sponsorDomain: sponsorDomain(n.evm.chainId), swapKeyDomain: startSwapDomain(n.evm.chainId) },
      bridge: {
        vaultAddress: n.bridge.vaultAddress,
        vaultEvmAddress: n.bridge.vaultEvmAddress,
        signetSingleton: n.bridge.signetSingleton,
      },
      tokens: config.tokens.tokens.map((t) => ({
        symbol: t.symbol,
        name: t.name,
        midnightName: t.midnightName,
        decimals: t.decimals,
        sepoliaAddress: t.sepoliaAddress,
        midnightColour: t.midnightColour,
      })),
      kernelUrl: n.zswap.kernelUrl,
      batcher: { url: n.zswap.batcherUrl, target: n.zswap.batcherTarget },
      limits: {
        authMaxTtlSeconds: limits.authMaxTtlSeconds,
        minOfferTtlSeconds: config.swaps.minOfferTtlSeconds,
        proofsPerSwap: config.swaps.proofsPerSwap,
      },
    };
    return c.json(body);
  });

  app.get(SWAP_PATHS.nonce, (c) => {
    const refused = limited(nonceLimiter, clientAddress(c), c);
    if (refused) return refused;
    const { nonce, expiresAt } = deps.nonces.issue();
    const body: NonceResponse = { nonce, expiresAt, maxTtlSeconds: limits.authMaxTtlSeconds };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  // ── open ───────────────────────────────────────────────────────────────────

  app.post(SWAP_PATHS.swaps, bodyLimited, async (c) => {
    const refused = limited(openLimiter, clientAddress(c), c);
    if (refused) return refused;
    const parsed = OpenSwapRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 400, 'bad-request', 'the request does not have the expected shape');
    const { swap: swapId, payload, auth } = parsed.data;
    const known = swaps.isKnown(swapId);
    // A NEW swap will cost the sponsor DUST: refuse before any nonce is spent if it cannot pay.
    if (!known) {
      const s = deps.sponsor.status();
      if (!s.synced) {
        return apiError(
          c,
          503,
          'sponsor-unavailable',
          'the sponsor cannot pay network fees right now; try again later',
        );
      }
      if (s.dustSpecks !== null && s.dustSpecks < config.sponsor.dustLowSpecks) {
        return apiError(c, 503, 'sponsor-low', 'the sponsor is low on network fee funds; try again later');
      }
    }
    const outcome = verifySponsorActionRequest(auth, {
      action: OPEN_SWAP_ACTION,
      network: config.network.name,
      chainId: config.network.evm.chainId,
      swap: swapId,
      payload,
      maxTtlSeconds: limits.authMaxTtlSeconds,
      nonces: deps.nonces,
      now: now(),
    });
    if (!outcome.ok) {
      log.info('open refused', { code: outcome.code });
      return apiError(c, 401, 'unauthorised', outcome.reason, outcome.code);
    }
    const ownerRefused = limited(ownerLimiter, outcome.signer.toLowerCase(), c);
    if (ownerRefused) return ownerRefused;
    const { token, rec, resumed } = await swaps.open({ swapId, payload, signer: outcome.signer });
    const body: OpenSwapResponse = {
      swapToken: token,
      depositAddress: rec.depositAddress,
      sweepGas: { ...rec.sweepGas },
      erc20Address: rec.pay.erc20Address,
      amount: rec.pay.amount,
      resumed,
      swap: swapView(rec),
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body, resumed ? 200 : 201);
  });

  // ── the swap (bearer) ──────────────────────────────────────────────────────

  app.get('/v1/swaps/:id', (c) => {
    const refused = limited(readLimiter, clientAddress(c), c);
    if (refused) return refused;
    c.header('Cache-Control', 'no-store');
    const rec = authorised(c);
    swaps.nudge(rec); // a page watching a swap that waits for funds: read its address on the next pass
    return c.json({ swap: swapView(rec) });
  });

  app.get('/v1/swaps/:id/withdraw-params', async (c) => {
    const refused = limited(readLimiter, clientAddress(c), c);
    if (refused) return refused;
    const rec = authorised(c);
    const kind = c.req.query('kind') ?? 'swap';
    if (!(WITHDRAW_KINDS as readonly string[]).includes(kind)) {
      return apiError(c, 400, 'bad-request', `kind must be one of ${WITHDRAW_KINDS.join(', ')}`);
    }
    c.header('Cache-Control', 'no-store');
    return c.json(await swaps.withdrawParams(rec, kind as WithdrawKind));
  });

  app.post('/v1/swaps/:id/prove', bodyLimited, async (c) => {
    const refused = limited(proveLimiter, clientAddress(c), c);
    if (refused) return refused;
    const rec = authorised(c);
    const perSwap = limited(proveSwapLimiter, rec.swapId, c);
    if (perSwap) return perSwap;
    const parsed = ProveRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 400, 'bad-request', 'the request does not have the expected shape');
    const proven = await swaps.prove(rec, parsed.data);
    return c.json({ tx: Buffer.from(proven).toString('hex') });
  });

  app.post('/v1/swaps/:id/withdraw', bodyLimited, async (c) => {
    const refused = limited(writeLimiter, clientAddress(c), c);
    if (refused) return refused;
    const rec = authorised(c);
    const parsed = WithdrawRequestSchema.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 400, 'bad-request', 'the request does not have the expected shape');
    const updated = swaps.withdraw(rec, parsed.data.tx);
    return c.json({ swap: swapView(updated) }, 202);
  });

  app.post('/v1/swaps/:id/take', bodyLimited, async (c) => {
    const refused = limited(writeLimiter, clientAddress(c), c);
    if (refused) return refused;
    const rec = authorised(c);
    const parsed = TakeReportSchema.safeParse(await readJson(c));
    if (!parsed.success) return apiError(c, 400, 'bad-request', 'the request does not have the expected shape');
    return c.json({ swap: swapView(swaps.reportTake(rec, parsed.data)) });
  });

  app.notFound((c) => apiError(c, 404, 'not-found', 'no such route'));
  app.onError((err, c) => {
    if (err instanceof SwapError) {
      if (err.status >= 500) log.warn('swap route refused', { path: c.req.path, code: err.code });
      return apiError(c, err.status, err.code, err.message, err.detail);
    }
    log.error('unhandled error', { path: c.req.path, error: err });
    return apiError(c, 500, 'internal-error', 'the sponsor hit an internal error');
  });

  return app;
}

/** The routes that change state, with how each is authorised (the auth tests enumerate them). */
export const STATE_CHANGING_ROUTES = [
  { method: 'POST', path: SWAP_PATHS.swaps, auth: 'eip712' },
  { method: 'POST', path: '/v1/swaps/:id/prove', auth: 'bearer' },
  { method: 'POST', path: '/v1/swaps/:id/withdraw', auth: 'bearer' },
  { method: 'POST', path: '/v1/swaps/:id/take', auth: 'bearer' },
] as const;

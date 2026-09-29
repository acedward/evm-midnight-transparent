// The sponsor's HTTP API (Hono). Routes:
//
//   GET  /health                  health (200 ok/degraded, 503 down; rate-limited in its own bucket)
//   GET  /v1/config               public configuration
//   GET  /v1/auth/nonce           a single-use nonce for a SponsorAction authorisation
//   POST /v1/actions/:action      THE ONLY state-changing route: every action is authorised
//   GET  /v1/jobs/:requestId      resume a job by its request id
//   GET  /v1/queue                queue depth per lane
//
// Request bodies are never logged. Errors are JSON: {"error": {"code", "message", "detail"?}}.
//
// Copied from MN Bank's relay (acedward/passport-evm-dapp @ 911647b, relay/src/app.ts) without its
// account, bridge-quote and Passport-call routes. TODO(L-SPONSOR): the swap routes and the
// proof-server proxy.

import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import {
  API_PATHS,
  ActionRequestSchema,
  SPONSOR_ACTIONS,
  type HealthResponse,
  type NonceResponse,
  type PublicConfig,
  type SponsorActionName,
} from '@evm-midnight-transparent/core';

import type { AdmissionOutcome } from './actions/admission.js';
import type { ActionDefinition } from './actions/catalogue.js';
import type { NonceStore } from './auth/nonces.js';
import { verifySponsorActionRequest } from './auth/verifiers.js';
import type { SponsorConfig } from './config.js';
import type { Logger } from './log.js';
import type { JobQueue } from './queue/jobs.js';
import { RateLimiter } from './ratelimit.js';
import type { SponsorSession } from './sponsor/session.js';

export interface AppDeps {
  config: SponsorConfig;
  version: string;
  log: Logger;
  nonces: NonceStore;
  queue: JobQueue;
  catalogue: ReadonlyMap<SponsorActionName, ActionDefinition>;
  sponsor: SponsorSession;
  health: () => Promise<HealthResponse>;
  /** The caller's address for rate limiting (default: the socket's, or X-Forwarded-For's last hop). */
  clientAddress?: (c: Context) => string;
  now?: () => number;
}

type ErrorStatus = 400 | 401 | 403 | 404 | 413 | 429 | 500 | 501 | 503;

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
  const { config, log } = deps;
  const clientAddress = deps.clientAddress ?? defaultClientAddress(config.trustProxy);
  const limits = config.limits;
  const readLimiter = new RateLimiter(limits.readsPerMinute);
  const healthLimiter = new RateLimiter(limits.healthPerMinute);
  const nonceLimiter = new RateLimiter(limits.noncesPerMinute);
  const actionLimiter = new RateLimiter(limits.actionsPerMinute);
  const ownerLimiter = new RateLimiter(limits.actionsPerOwnerPerMinute);
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
        allowHeaders: ['content-type'],
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

  // ── reads ──────────────────────────────────────────────────────────────────

  app.get(API_PATHS.health, async (c) => {
    // Its own bucket, so a monitor is never starved by a user's reads.
    const refused = limited(healthLimiter, clientAddress(c), c);
    if (refused) return refused;
    const h = await deps.health();
    return c.json(h, h.status === 'down' ? 503 : 200);
  });

  app.get(API_PATHS.config, (c) => {
    const body: PublicConfig = {
      network: config.network.name,
      chainId: config.network.evm.chainId,
      sponsorVersion: deps.version,
      bridge: {
        vaultAddress: config.network.bridge.vaultAddress,
        vaultEvmAddress: config.network.bridge.vaultEvmAddress,
      },
      limits: { authMaxTtlSeconds: limits.authMaxTtlSeconds, jobTtlSeconds: limits.jobTtlSeconds },
    };
    return c.json(body);
  });

  app.get(API_PATHS.nonce, (c) => {
    const refused = limited(nonceLimiter, clientAddress(c), c);
    if (refused) return refused;
    const { nonce, expiresAt } = deps.nonces.issue();
    const body: NonceResponse = { nonce, expiresAt, maxTtlSeconds: limits.authMaxTtlSeconds };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });

  app.get('/v1/jobs/:requestId', (c) => {
    const refused = limited(readLimiter, clientAddress(c), c);
    if (refused) return refused;
    const id = c.req.param('requestId');
    if (!/^[0-9a-f]{32}$/.test(id)) return apiError(c, 400, 'bad-request', 'not a request id');
    const job = deps.queue.get(id);
    return job
      ? c.json({ job })
      : apiError(c, 404, 'not-found', 'no such job (it may have expired, or the sponsor restarted)');
  });

  app.get(API_PATHS.queue, (c) => {
    const refused = limited(readLimiter, clientAddress(c), c);
    if (refused) return refused;
    return c.json(deps.queue.stats());
  });

  // ── the one state-changing route ─────────────────────────────────────────

  app.post(
    '/v1/actions/:action',
    bodyLimit({
      maxSize: limits.maxBodyBytes,
      onError: (c) => apiError(c, 413, 'payload-too-large', 'the request body is too large'),
    }),
    async (c) => {
      const refused = limited(actionLimiter, clientAddress(c), c);
      if (refused) return refused;
      const name = c.req.param('action') as SponsorActionName;
      const def = (SPONSOR_ACTIONS as readonly string[]).includes(name) ? deps.catalogue.get(name) : undefined;
      if (!def) return apiError(c, 404, 'not-found', 'no such action');

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return apiError(c, 400, 'bad-request', 'the body must be JSON');
      }
      const parsed = ActionRequestSchema.safeParse(body);
      if (!parsed.success) return apiError(c, 400, 'bad-request', 'the request does not have the expected shape');
      const request = parsed.data;
      const swap = request.swap?.replace(/^0x/, '').toLowerCase();
      if (def.requiresSwap && !swap) return apiError(c, 400, 'bad-request', 'this action needs a swap');
      if (!def.requiresSwap && swap) return apiError(c, 400, 'bad-request', 'this action takes no swap');
      const payload = def.payload.safeParse(request.payload);
      if (!payload.success) return apiError(c, 400, 'bad-request', 'the action arguments are not valid');

      // Before consuming any nonce: can the sponsor pay for this at all?
      if (def.requiresSponsor) {
        const s = deps.sponsor.status();
        if (!s.synced)
          return apiError(
            c,
            503,
            'sponsor-unavailable',
            'the sponsor cannot pay network fees right now; try again later',
          );
        if (s.dustSpecks !== null && s.dustSpecks < config.sponsor.dustLowSpecks) {
          return apiError(c, 503, 'sponsor-low', 'the sponsor is low on network fee funds; try again later');
        }
      }

      const outcome = verifySponsorActionRequest(request.auth, {
        action: def.action,
        network: config.network.name,
        chainId: config.network.evm.chainId,
        swap,
        payload: request.payload,
        maxTtlSeconds: limits.authMaxTtlSeconds,
        nonces: deps.nonces,
        now: now(),
      });
      if (!outcome.ok) {
        log.info('action refused', { action: def.action, code: outcome.code });
        return apiError(c, 401, 'unauthorised', outcome.reason, outcome.code);
      }

      const ownerRefused = limited(ownerLimiter, outcome.signer.toLowerCase(), c);
      if (ownerRefused) return ownerRefused;

      // The action's own admission check, before any queue slot.
      let admitted: AdmissionOutcome = { ok: true };
      if (def.admit) {
        try {
          admitted = await def.admit({ swap, payload: payload.data, signer: outcome.signer });
        } catch (e) {
          log.warn('admission check failed', { action: def.action, error: e });
          return apiError(c, 503, 'chain-unavailable', 'the swap could not be checked right now; try again shortly');
        }
        if (!admitted.ok) {
          log.info('action refused', { action: def.action, code: admitted.detail ?? admitted.code });
          return apiError(c, admitted.status, admitted.code, admitted.reason, admitted.detail);
        }
      }

      let job: ReturnType<JobQueue['submit']> = null;
      try {
        job = deps.queue.submit({
          action: def.action,
          lane: def.lane,
          swap,
          payload: {
            ...request.payload,
            ...(request.auth ? { auth: request.auth } : {}),
            ...(swap ? { swap } : {}),
            signer: outcome.signer,
          },
          executor: def.executor,
        });
      } finally {
        // Refused after admission (a full queue, or an error): give back what the admission claimed.
        if (!job && admitted.ok) admitted.release?.();
      }
      if (!job) return apiError(c, 503, 'busy', 'the sponsor is at capacity; try again later');
      log.info('action queued', { action: def.action, requestId: job.requestId });
      return c.json({ job }, 202);
    },
  );

  app.notFound((c) => apiError(c, 404, 'not-found', 'no such route'));
  app.onError((err, c) => {
    log.error('unhandled error', { path: c.req.path, error: err });
    return apiError(c, 500, 'internal-error', 'the sponsor hit an internal error');
  });

  return app;
}

/** The routes that change state, for the auth test to enumerate (every one must refuse
 *  unsigned or wrongly signed calls). */
export const STATE_CHANGING_ROUTES = SPONSOR_ACTIONS.map((a) => ({
  method: 'POST',
  path: API_PATHS.action(a),
  action: a,
}));

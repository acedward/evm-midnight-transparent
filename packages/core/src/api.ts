// The sponsor's HTTP API: the generic shapes (errors, nonces, health). The browser and the sponsor
// both import these, so a change here is a change of the wire contract for both.
//
// Copied from MN Bank's relay API (acedward/passport-evm-dapp @ 911647b, packages/core/src/api.ts)
// without its account routes. L-SPONSOR (plan 00048) replaced the seed's generic action/job routes
// with the swap routes: see ./swap-api.ts for the paths, bodies and the swap state machine.

import { z } from 'zod';

import { SWAP_PATHS } from './swap-api.js';

export const API_PATHS = {
  /** Also served at `/v1/health`; `/health` stays for monitors. */
  health: '/health',
  config: SWAP_PATHS.config,
  nonce: SWAP_PATHS.nonce,
} as const;

// ── Errors ──────────────────────────────────────────────────────────────────

export const ApiErrorSchema = z.object({
  error: z.object({
    /** Machine-readable: `unauthorised`, `rate-limited`, `not-found`, `bad-request`, … */
    code: z.string(),
    message: z.string(),
    /** For auth failures, the precise reason (see AuthFailureCode); for `invalid-tx`, the rule. */
    detail: z.string().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ── Nonces ──────────────────────────────────────────────────────────────────

export const NonceResponseSchema = z.object({
  nonce: z.string().regex(/^0x[0-9a-f]{64}$/),
  /** Unix seconds after which the sponsor forgets the nonce. */
  expiresAt: z.number().int(),
  /** The furthest ahead an authorisation's expiry may be, in seconds. */
  maxTtlSeconds: z.number().int(),
});
export type NonceResponse = z.infer<typeof NonceResponseSchema>;

// ── Health ──────────────────────────────────────────────────────────────────

export const HEALTH_STATUSES = ['ok', 'degraded', 'down'] as const;

export const HealthResponseSchema = z.object({
  status: z.enum(HEALTH_STATUSES),
  network: z.string(),
  version: z.string(),
  uptimeSeconds: z.number().int(),
  sponsor: z.object({
    configured: z.boolean(),
    state: z.string(),
    synced: z.boolean(),
    /** DUST balance in specks (10^-15 DUST), decimal string; null when unknown. */
    dustSpecks: z.string().nullable(),
    dustLow: z.boolean(),
  }),
  proofServer: z.object({
    reachable: z.boolean(),
    version: z.string().nullable(),
    jobCapacity: z.number().nullable(),
  }),
  /** The sponsor's lanes: proofs (one at a time) and the vault's withdrawal lane. */
  queue: z.object({
    jobs: z.number().int(),
    lanes: z.record(z.string(), z.object({ running: z.number().int(), waiting: z.number().int() })),
  }),
  kernel: z.object({ reachable: z.boolean(), synced: z.boolean().nullable() }),
  batcher: z.object({ reachable: z.boolean() }),
  vaultGas: z.object({
    address: z.string(),
    balanceWei: z.string().nullable(),
    low: z.boolean().nullable(),
  }),
  /** The bridge as this sponsor drives it: whether the vault keys matched the chain at start-up,
   *  the swaps by state, the MPC's recent behaviour and the stale closer. */
  bridge: z
    .object({
      available: z.boolean(),
      keysVerified: z.boolean().nullable(),
      swaps: z.record(z.string(), z.number().int()),
      mpc: z.object({
        lastSignatureAfterSeconds: z.number().nullable(),
        timeouts24h: z.number().int(),
        inFlight: z.number().int(),
      }),
      staleCloser: z.object({
        enabled: z.boolean(),
        lastScanAt: z.number().int().nullable(),
        closed24h: z.number().int(),
        maxPerDay: z.number().int(),
        paused: z.string().nullable(),
      }),
      /** The sponsorship budget over the last 24 h (audit C6/C7): DUST paid (specks, decimal
       *  strings; a budget of "0" means none is set), new swaps opened, and the swaps waiting for
       *  funds against their global cap. `exhausted`: new swaps are refused until it frees. */
      budget: z
        .object({
          dustSpentSpecks24h: z.string(),
          dustBudgetSpecks24h: z.string(),
          swapsOpened24h: z.number().int(),
          unfundedOpen: z.number().int(),
          unfundedMax: z.number().int(),
          exhausted: z.boolean(),
        })
        .optional(),
      /** The vault account's nonces this sponsor holds for its open withdrawal requests (audit
       *  C2/C3): a reservation lasts until its request settles or the nonce is consumed. `stuck`:
       *  signed but not mined past the stuck threshold (or never signed past the long one), so the
       *  next withdrawal replaces it; see deploy/RUNBOOK.md for the operator procedure. */
      reservations: z
        .array(
          z.object({
            nonce: z.string(),
            swapId: z.string(),
            signed: z.boolean(),
            mined: z.boolean(),
            stuck: z.boolean(),
            /** A submission whose outcome is unknown (audit R5): kept until the request id settles it. */
            uncertain: z.boolean().optional(),
            sinceSeconds: z.number().int(),
          }),
        )
        .optional(),
    })
    .optional(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

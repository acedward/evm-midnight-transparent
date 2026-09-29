// The sponsor's HTTP API: paths, request and response shapes. The browser and the sponsor both
// import these, so a change here is a change of the wire contract for both.
//
// Copied from MN Bank's relay API (acedward/passport-evm-dapp @ 911647b, packages/core/src/api.ts)
// without its account routes. State-changing requests are `POST /v1/actions/:action`, each
// carrying a signed authorisation (see ./auth.ts). The sponsor keeps no per-user data: a job lives
// in its memory until its TTL, and the browser keeps the request id to resume it.
//
// TODO(L-SPONSOR): the swap routes (deposit address watch, withdraw submission, the proof-server
// proxy, the stale closer's view) and their bodies.

import { z } from 'zod';

import { SPONSOR_ACTIONS, type SponsorActionName, SignedSponsorActionSchema } from './auth.js';

export const API_PATHS = {
  health: '/health',
  config: '/v1/config',
  nonce: '/v1/auth/nonce',
  action: (action: SponsorActionName) => `/v1/actions/${action}`,
  job: (requestId: string) => `/v1/jobs/${requestId}`,
  queue: '/v1/queue',
} as const;

// ── Errors ──────────────────────────────────────────────────────────────────

export const ApiErrorSchema = z.object({
  error: z.object({
    /** Machine-readable: `unauthorised`, `rate-limited`, `not-found`, `bad-request`, … */
    code: z.string(),
    message: z.string(),
    /** For auth failures, the precise reason (see AuthFailureCode). */
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

// ── Actions and jobs ────────────────────────────────────────────────────────

/** A lane is the queue a job waits in: proofs and sponsor-balanced transactions one at a time;
 *  bridge deposits one at a time per swap (each swap has its own deposit address); bridge
 *  withdrawals one at a time across the whole sponsor (they share the vault's EVM account and its
 *  nonce). */
export const JOB_LANES = ['prover', 'deposit', 'withdrawal'] as const;
export type JobLane = (typeof JOB_LANES)[number];

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobState = (typeof JOB_STATES)[number];

export const JobStageSchema = z.object({
  /** A short stable id, e.g. `queued`, `proving`, `submitted`, `mpc-signature`. */
  stage: z.string(),
  at: z.number().int(),
  /** Public details only: transaction hashes, request ids, heights. Never a secret. */
  detail: z.record(z.string(), z.string()).optional(),
});
export type JobStage = z.infer<typeof JobStageSchema>;

/** Jobs the sponsor runs on its own, never requested through a route: closing a bridge request
 *  left open (the stale closer). `POST /v1/actions/bridge-close` does not exist. */
export const INTERNAL_JOB_ACTIONS = ['bridge-close'] as const;
export type InternalJobAction = (typeof INTERNAL_JOB_ACTIONS)[number];
export type JobActionName = SponsorActionName | InternalJobAction;

export const JobViewSchema = z.object({
  requestId: z.string().regex(/^[0-9a-f]{32}$/),
  action: z.enum([...SPONSOR_ACTIONS, ...INTERNAL_JOB_ACTIONS]),
  lane: z.enum(JOB_LANES),
  state: z.enum(JOB_STATES),
  /** The newest stage. */
  stage: z.string(),
  stages: z.array(JobStageSchema),
  /** 1-based position among the jobs waiting in the same queue, while queued. */
  position: z.number().int().positive().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** Unix seconds after which the sponsor forgets this job. */
  expiresAt: z.number().int(),
  /** Public outcome (addresses, hashes). */
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export type JobView = z.infer<typeof JobViewSchema>;

export const ActionRequestSchema = z.object({
  /** The swap the action is for (64 hex), when the action names one. */
  swap: z
    .string()
    .regex(/^(0x)?[0-9a-f]{64}$/)
    .optional(),
  /** The action's arguments. Bytes are hex strings, amounts decimal strings. */
  payload: z.record(z.string(), z.unknown()),
  /** The sponsor authorisation (a SponsorAction signature). */
  auth: SignedSponsorActionSchema.optional(),
});
export type ActionRequest = z.infer<typeof ActionRequestSchema>;

export const ActionResponseSchema = z.object({ job: JobViewSchema });
export type ActionResponse = z.infer<typeof ActionResponseSchema>;

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
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// ── Public configuration ────────────────────────────────────────────────────

export const PublicConfigSchema = z.object({
  network: z.string(),
  chainId: z.number().int(),
  sponsorVersion: z.string(),
  bridge: z.object({
    vaultAddress: z.string(),
    vaultEvmAddress: z.string(),
  }),
  limits: z.object({
    authMaxTtlSeconds: z.number().int(),
    jobTtlSeconds: z.number().int(),
  }),
});
export type PublicConfig = z.infer<typeof PublicConfigSchema>;

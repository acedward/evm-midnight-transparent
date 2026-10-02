// How a state-changing request proves who asked for it: a SponsorAction EIP-712 signature
// (packages/core/src/auth.ts) over the action, network, owner, swap, a hash of the body, a
// sponsor-issued single-use nonce and an expiry. The route refuses the request unless it verifies.
//
// Copied from MN Bank's relay (acedward/passport-evm-dapp @ 911647b, relay/src/auth/verifiers.ts)
// with only its signed-action kind.

import { verifySponsorAction, type AuthFailureCode, type SponsorActionName } from '@evm-midnight-transparent/core';

import type { NonceStore } from './nonces.js';

export type VerifyOutcome = { ok: true; signer: string } | { ok: false; code: AuthFailureCode; reason: string };

export interface SponsorActionContext {
  action: SponsorActionName;
  network: string;
  chainId: number;
  swap?: string;
  payload: unknown;
  maxTtlSeconds: number;
  nonces: NonceStore;
  now?: number;
}

export function verifySponsorActionRequest(auth: unknown, ctx: SponsorActionContext): VerifyOutcome {
  const r = verifySponsorAction(auth, {
    expectedAction: ctx.action,
    network: ctx.network,
    chainId: ctx.chainId,
    expectedSwap: ctx.swap,
    payload: ctx.payload,
    maxTtlSeconds: ctx.maxTtlSeconds,
    now: ctx.now,
    consumeNonce: (nonce) => ctx.nonces.consume(nonce),
  });
  if (!r.ok) return r;
  return { ok: true, signer: r.signer };
}

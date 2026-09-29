// Every state-changing action the sponsor offers, with its lane, whether it names a swap, the
// shape of its body, and its executor.
//
// Copied from MN Bank's relay catalogue (acedward/passport-evm-dapp @ 911647b,
// relay/src/actions/catalogue.ts) without its Passport actions. Every executor is a stub that
// fails with `not-implemented` until the sponsor lane fills it in.
//
// TODO(L-SPONSOR): the swap session, the deposit driver (`startDeposit`, the relayer,
// `completeDeposit` with the temporary wallet's encryption-key mapping), the withdraw endpoint
// (refuse anything but the vault's `startWithdraw` for this swap; add DUST; one withdrawal lane),
// the resume, and the proof-server proxy.

import { z } from 'zod';

import { SPONSOR_ACTIONS, type JobLane, type SponsorActionName } from '@evm-midnight-transparent/core';

import type { AdmissionCheck } from './admission.js';
import { PublicError, type JobExecutor } from '../queue/jobs.js';

export interface ActionDefinition {
  action: SponsorActionName;
  lane: JobLane;
  /** Whether the request names a swap (the signed message binds it). */
  requiresSwap: boolean;
  /** Whether the action spends the sponsor's DUST (refused while the sponsor is not ready). */
  requiresSponsor: boolean;
  payload: z.ZodType<Record<string, unknown>>;
  /** An extra check before the job is queued (./admission.ts). */
  admit?: AdmissionCheck;
  executor: JobExecutor;
  /** The plan lane that implements the executor. */
  implementedBy: string;
}

/** Until a lane defines its action's body, any JSON object (the size limit still applies). */
const anyObject = z.record(z.string(), z.unknown());

const notImplemented =
  (action: SponsorActionName, lane: string): JobExecutor =>
  async () => {
    throw new PublicError('not-implemented', `the ${action} operation is not available yet (plan lane ${lane})`);
  };

const def = (
  action: SponsorActionName,
  lane: JobLane,
  implementedBy: string,
  extra: Partial<Pick<ActionDefinition, 'requiresSwap' | 'payload'>> = {},
): ActionDefinition => ({
  action,
  lane,
  requiresSwap: extra.requiresSwap ?? true,
  requiresSponsor: true,
  payload: extra.payload ?? anyObject,
  executor: notImplemented(action, implementedBy),
  implementedBy,
});

export function defaultCatalogue(): Map<SponsorActionName, ActionDefinition> {
  const list: ActionDefinition[] = [
    def('swap-open', 'prover', 'L-SPONSOR'),
    // A swap's deposit address is its own, so deposits of different swaps run side by side.
    def('bridge-deposit', 'deposit', 'L-SPONSOR'),
    // Every withdrawal shares the vault EVM account's nonce: one lane across the sponsor.
    def('bridge-withdraw', 'withdrawal', 'L-SPONSOR'),
    def('bridge-resume', 'deposit', 'L-SPONSOR'),
    def('prove', 'prover', 'L-SPONSOR'),
  ];
  const map = new Map(list.map((d) => [d.action, d]));
  for (const a of SPONSOR_ACTIONS) if (!map.has(a)) throw new Error(`action ${a} has no definition`);
  return map;
}

// Reading a transaction's public structure with ledger-v9 (1.0.0-rc.3), for ./rules.ts.
//
// The wire forms (plan "Lane contracts", L-SPONSOR's answer items 8–9):
//   unproven  Transaction<signature, pre-proof, pre-binding>   (UnprovenTransaction.serialize(): /prove's input)
//   proven    Transaction<signature, proof, pre-binding>       (/prove's answer, before the browser binds it)
//   final     Transaction<signature, proof, binding>           (/withdraw's input)
// A value that does not deserialise with the expected markers is refused as `not-a-transaction`.

import * as ledger from '@midnightntwrk/ledger-v9';

import { InvalidTxError } from './rules.js';
import {
  callDigest,
  callsDigestOf,
  entryPointText,
  normaliseAddress,
  structureDigestOf,
  type CallSummary,
  type TxSummary,
} from './summary.js';

export type TxStage = 'unproven' | 'proven' | 'final';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const MARKERS: Record<TxStage, [string, string, string]> = {
  unproven: ['signature', 'pre-proof', 'pre-binding'],
  proven: ['signature', 'proof', 'pre-binding'],
  final: ['signature', 'proof', 'binding'],
};

/** Deserialize `bytes` as a transaction of `stage`; throws InvalidTxError('not-a-transaction'). */
export function decodeTransaction(bytes: Uint8Array, stage: TxStage): Any {
  const [s, p, b] = MARKERS[stage];
  try {
    return (ledger.Transaction as Any).deserialize(s, p, b, bytes);
  } catch {
    throw new InvalidTxError('not-a-transaction', `this is not a ${stage} ledger-v9 transaction`);
  }
}

function shieldedImbalances(tx: Any, segment: number): { shielded: Record<string, bigint>; unshielded: number } {
  const shielded: Record<string, bigint> = {};
  let unshielded = 0;
  for (const [type, value] of (tx.imbalances(segment) as Map<Any, bigint>).entries()) {
    if (value === 0n) continue;
    if (type.tag === 'shielded') shielded[String(type.raw).replace(/^0x/, '').toLowerCase()] = value;
    else if (type.tag === 'unshielded') unshielded++;
  }
  return { shielded, unshielded };
}

/** The structure of a decoded transaction (any stage). */
export function summarise(tx: Any): TxSummary {
  if (tx.rewards !== undefined)
    throw new InvalidTxError('not-a-transaction', 'a rewards claim is not a swap transaction');
  const calls: CallSummary[] = [];
  let deploys = 0;
  let maintenanceUpdates = 0;
  let unshielded = false;
  let dust = false;
  const segments = [0];
  const intents = (tx.intents as Map<number, Any> | undefined) ?? new Map();
  for (const [segment, intent] of [...intents.entries()].sort(([a], [b]) => a - b)) {
    segments.push(segment);
    if (intent.guaranteedUnshieldedOffer !== undefined || intent.fallibleUnshieldedOffer !== undefined)
      unshielded = true;
    const d = intent.dustActions;
    if (d && ((d.spends?.length ?? 0) > 0 || (d.registrations?.length ?? 0) > 0)) dust = true;
    for (const action of intent.actions as Any[]) {
      if (action instanceof ledger.ContractCall) {
        const address = normaliseAddress(String(action.address));
        const entryPoint = entryPointText(action.entryPoint);
        calls.push({
          address,
          entryPoint,
          digest: callDigest({
            address,
            entryPoint,
            guaranteedTranscript: action.guaranteedTranscript,
            fallibleTranscript: action.fallibleTranscript,
          }),
        });
      } else if (action instanceof ledger.ContractDeploy) deploys++;
      else maintenanceUpdates++;
    }
  }
  const imbalances: Record<string, Record<string, bigint>> = {};
  let unshieldedImbalances = 0;
  for (const seg of segments) {
    const i = shieldedImbalances(tx, seg);
    if (Object.keys(i.shielded).length > 0) imbalances[String(seg)] = i.shielded;
    unshieldedImbalances += i.unshielded;
  }
  const g = tx.guaranteedOffer as Any;
  const owner = (c: unknown) => (c === undefined || c === null ? null : normaliseAddress(String(c)));
  const shielded: TxSummary['shielded'] = {
    inputs: ((g?.inputs ?? []) as Any[]).map((i) => ({
      nullifier: String(i.nullifier),
      contract: owner(i.contractAddress),
    })),
    outputs: ((g?.outputs ?? []) as Any[]).map((o) => ({
      commitment: String(o.commitment),
      contract: owner(o.contractAddress),
    })),
  };
  const callsDigest = callsDigestOf(calls);
  return {
    intents: intents.size,
    calls,
    deploys,
    maintenanceUpdates,
    unshielded: unshielded || unshieldedImbalances > 0,
    dust,
    fallibleShielded: ((tx.fallibleOffer as Map<number, Any> | undefined)?.size ?? 0) > 0,
    guaranteed: g ? { inputs: g.inputs.length, outputs: g.outputs.length, transients: g.transients.length } : null,
    imbalances,
    unshieldedImbalances,
    callsDigest,
    segments,
    shielded,
    structureDigest: structureDigestOf({ callsDigest, segments, shielded }),
  };
}

/** Decode and summarise in one step. */
export function inspectTransaction(bytes: Uint8Array, stage: TxStage): { tx: Any; summary: TxSummary } {
  const tx = decodeTransaction(bytes, stage);
  let summary: TxSummary;
  try {
    summary = summarise(tx);
  } catch (e) {
    if (e instanceof InvalidTxError) throw e;
    throw new InvalidTxError('not-a-transaction', 'the transaction could not be read');
  }
  return { tx, summary };
}

/** The imbalances (segment 0) of a maker's finalized offer transaction, from its bytes. */
export function makerImbalances(bytes: Uint8Array): Record<string, bigint> {
  const tx = decodeTransaction(bytes, 'final');
  return shieldedImbalances(tx, 0).shielded;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

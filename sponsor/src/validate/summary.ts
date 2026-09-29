// What the sponsor reads from a transaction before it proves it or pays DUST for it: a summary of
// its public structure, taken with ledger-v9 (./inspect.ts) and judged by pure rules (./rules.ts).
//
// A contract call is summarised by its address, its entry point and a DIGEST of its public
// transcripts (the guaranteed and fallible programs and their effects, i.e. every value the call
// discloses: its arguments as stored, the coins it claims, the calls it makes). Two calls with
// equal digests behave identically on chain. The digest leaves out only what is random per build:
// the call's own communication commitment and proof, and a caller's communication commitment to its
// callee (randomised per call), both in its `claimedContractCalls` effect and where its program
// pushes it (the callee's own transcripts, compared call by call, bind what it was called with).

import { createHash } from 'node:crypto';

export interface CallSummary {
  /** The called contract, 64 lowercase hex. */
  address: string;
  /** The entry point's name (or its bytes as hex). */
  entryPoint: string;
  /** sha256 of the call's canonical public transcripts. */
  digest: string;
}

export interface TxSummary {
  /** How many intents (segments ≥ 1) the transaction has. */
  intents: number;
  /** Every contract call, in intent order then action order. */
  calls: CallSummary[];
  /** Contract deploys and maintenance updates (never accepted). */
  deploys: number;
  maintenanceUpdates: number;
  /** Any guaranteed or fallible unshielded offer. */
  unshielded: boolean;
  /** Any DUST spend or registration. */
  dust: boolean;
  /** Any fallible shielded offer. */
  fallibleShielded: boolean;
  /** The guaranteed shielded offer's coin counts, or null when there is none. */
  guaranteed: { inputs: number; outputs: number; transients: number } | null;
  /** Non-zero SHIELDED imbalances per segment (segment -> colour -> base units; positive = surplus). */
  imbalances: Record<string, Record<string, bigint>>;
  /** Non-zero UNSHIELDED imbalances, any segment. */
  unshieldedImbalances: number;
  /** sha256 over every call's digest, in order: what `/withdraw` must match. */
  callsDigest: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

const hexOf = (b: Uint8Array) => Buffer.from(b).toString('hex');

/**
 * A deterministic JSON form of the values ledger-v9 hands out (plain objects, arrays, Maps,
 * bigints, byte arrays, strings, numbers, booleans). Map entries are sorted by their key's
 * canonical form, object keys alphabetically.
 */
export function canonical(value: unknown, depth = 0): unknown {
  if (depth > 64) throw new Error('value too deep to canonicalise');
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'bigint':
      return { $n: value.toString(10) };
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : { $num: String(value) };
    case 'object': {
      if (value instanceof Uint8Array) return { $b: hexOf(value) };
      if (Array.isArray(value)) return value.map((v) => canonical(v, depth + 1));
      if (value instanceof Map) {
        const entries = [...value.entries()].map(
          ([k, v]) => [canonical(k, depth + 1), canonical(v, depth + 1)] as const,
        );
        entries.sort(([a], [b]) => {
          const x = JSON.stringify(a);
          const y = JSON.stringify(b);
          return x < y ? -1 : x > y ? 1 : 0;
        });
        return { $m: entries };
      }
      if (value instanceof Set) return { $s: [...value].map((v) => JSON.stringify(canonical(v, depth + 1))).sort() };
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        out[k] = canonical((value as Record<string, unknown>)[k], depth + 1);
      }
      return out;
    }
    default:
      throw new Error(`cannot canonicalise a ${typeof value}`);
  }
}

const leafHex = (v: unknown): string | null =>
  v instanceof Uint8Array ? hexOf(v) : typeof v === 'string' && /^[0-9a-fA-F]+$/.test(v) ? v.toLowerCase() : null;

/** The communication commitments a transcript's effects claim for its callees (random per call). */
function commitmentsOf(t: unknown): string[] {
  const calls = (t as { effects?: { claimedContractCalls?: unknown[] } } | null)?.effects?.claimedContractCalls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((c) => {
    const h = Array.isArray(c) ? leafHex(c[3]) : null;
    return h && h.length >= 62 ? [h] : [];
  });
}

/** Replace every byte string that is (the tail of) one of `secrets` by a marker, anywhere in `v`. */
function maskBytes(v: unknown, commitments: readonly string[], depth = 0): unknown {
  if (depth > 64 || commitments.length === 0) return v;
  if (v instanceof Uint8Array) {
    const h = hexOf(v);
    return h.length >= 62 && commitments.some((c) => c === h || c.endsWith(h)) ? '$commitment' : v;
  }
  if (Array.isArray(v)) return v.map((x) => maskBytes(x, commitments, depth + 1));
  if (v instanceof Map) return new Map([...v.entries()].map(([k, x]) => [k, maskBytes(x, commitments, depth + 1)]));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = maskBytes(x, commitments, depth + 1);
    return out;
  }
  return v;
}

/**
 * A transcript with the per-build randomness masked (see the header): the communication commitment
 * of each callee, both where the effects claim it and where the program pushes it.
 */
function maskTranscript(t: unknown): unknown {
  if (!t || typeof t !== 'object') return t ?? null;
  const commitments = commitmentsOf(t);
  const tr = t as { effects?: { claimedContractCalls?: unknown[] } };
  const calls = tr.effects?.claimedContractCalls;
  const masked = {
    ...(t as object),
    ...(Array.isArray(calls)
      ? {
          effects: {
            ...tr.effects,
            claimedContractCalls: calls.map((c) => (Array.isArray(c) ? [c[0], c[1], c[2], '$commitment'] : c)),
          },
        }
      : {}),
  };
  return maskBytes(masked, commitments);
}

export function callDigest(call: {
  address: string;
  entryPoint: string;
  guaranteedTranscript: unknown;
  fallibleTranscript: unknown;
}): string {
  return sha256(
    JSON.stringify(
      canonical({
        address: call.address,
        entryPoint: call.entryPoint,
        guaranteed: maskTranscript(call.guaranteedTranscript),
        fallible: maskTranscript(call.fallibleTranscript),
      }),
    ),
  );
}

export const callsDigestOf = (calls: readonly CallSummary[]): string =>
  sha256(JSON.stringify(calls.map((c) => [c.address, c.entryPoint, c.digest])));

export const normaliseAddress = (a: string) => a.replace(/^0x/i, '').toLowerCase();

export const entryPointText = (e: Uint8Array | string): string =>
  typeof e === 'string' ? e : new TextDecoder('utf-8', { fatal: false }).decode(e);

// The transaction reader over REAL ledger-v9 transactions (../src/validate/inspect.ts): wire
// markers, imbalances, coin counts, contract calls and their transcript digests (stable across
// builds, blind to per-build randomness, sensitive to every disclosed value).

import { createHash } from 'node:crypto';

import * as l from '@midnightntwrk/ledger-v9';
import { describe, expect, it } from 'vitest';

import { decodeTransaction, inspectTransaction, makerImbalances, summarise } from '../src/validate/inspect.js';
import { InvalidTxError, validateTake, validateWithdraw } from '../src/validate/rules.js';
import { callDigest, canonical } from '../src/validate/summary.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const L = l as any;
const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const VAULT = 'cc'.repeat(32);
const SINGLETON = 'dd'.repeat(32);
const keys = l.ZswapSecretKeys.fromSeed(new Uint8Array(32).fill(7));

function outputsTx(outputs: [string, bigint][]): any {
  let offer: any;
  for (const [colour, value] of outputs) {
    const coin = L.createShieldedCoinInfo(colour, value);
    const out = L.ZswapOutput.new(coin, 0, keys.coinPublicKey, keys.encryptionPublicKey);
    const o = L.ZswapOffer.fromOutput(out, colour, value);
    offer = offer ? offer.merge(o) : o;
  }
  return L.Transaction.fromParts('stagenet', offer);
}

const gas = { readTime: 0n, computeTime: 0n, bytesWritten: 0n, bytesDeleted: 0n };
function effects(over: Record<string, unknown> = {}) {
  return {
    claimedNullifiers: [],
    claimedShieldedReceives: [],
    claimedShieldedSpends: [],
    claimedContractCalls: [],
    shieldedMints: new Map(),
    unshieldedMints: new Map(),
    unshieldedInputs: new Map(),
    unshieldedOutputs: new Map(),
    claimedUnshieldedSpends: new Map(),
    ...over,
  };
}
const aligned = { value: [], alignment: [] };

function callTx(
  calls: { address: string; entry: string; program?: unknown[]; effects?: Record<string, unknown> }[],
): any {
  let intent = L.Intent.new(new Date(Date.now() + 60_000));
  for (const c of calls) {
    const tr = { gas, effects: effects(c.effects), program: c.program ?? [{ noop: { n: 1 } }] };
    intent = intent.addCall(
      new L.ContractCallPrototype(
        c.address,
        c.entry,
        new L.ContractOperation(),
        tr,
        undefined,
        [],
        aligned,
        aligned,
        L.communicationCommitmentRandomness(),
        'k',
      ),
    );
  }
  return L.Transaction.fromParts('stagenet', undefined, undefined, intent);
}

const detailOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof InvalidTxError) return e.detail;
    throw e;
  }
  return 'accepted';
};

describe('decoding', () => {
  it('reads an unproven transaction and refuses garbage and the wrong wire stage', () => {
    const bytes = outputsTx([[A, 1000n]]).serialize();
    expect(() => decodeTransaction(bytes, 'unproven')).not.toThrow();
    expect(detailOf(() => decodeTransaction(bytes, 'final'))).toBe('not-a-transaction');
    expect(detailOf(() => decodeTransaction(bytes, 'proven'))).toBe('not-a-transaction');
    expect(detailOf(() => decodeTransaction(new Uint8Array([1, 2, 3]), 'unproven'))).toBe('not-a-transaction');
  });
});

describe('the shielded side', () => {
  it('reports segment-0 imbalances per colour and the coin counts', () => {
    const { summary } = inspectTransaction(
      outputsTx([
        [A, 1000n],
        [B, 5n],
      ]).serialize(),
      'unproven',
    );
    expect(summary.imbalances).toEqual({ '0': { [A]: -1000n, [B]: -5n } });
    expect(summary.guaranteed).toEqual({ inputs: 0, outputs: 2, transients: 0 });
    expect(summary).toMatchObject({ intents: 0, calls: [], unshielded: false, dust: false, fallibleShielded: false });
    // a take must spend +pay into the offer: outputs alone are not a take of any offer
    expect(
      detailOf(() => validateTake(summary, { pay: { colour: A, amount: 1000n }, receive: { colour: B, amount: 5n } })),
    ).toBe('wrong-offer');
    // audit C4: every shielded coin is read (commitments of users' coins: no contract) and bound
    // into the structure digest, which a proof-erased copy keeps
    expect(summary.shielded.inputs).toEqual([]);
    expect(summary.shielded.outputs).toHaveLength(2);
    for (const o of summary.shielded.outputs)
      expect(o).toMatchObject({ commitment: expect.stringMatching(/^[0-9a-f]{64}$/), contract: null });
    expect(summary.structureDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reads a maker offer’s imbalances from its finalized bytes', () => {
    // a finalized offer needs proofs; the reader refuses an unproven one as not-a-transaction
    expect(() => makerImbalances(outputsTx([[A, 1n]]).serialize())).toThrow(InvalidTxError);
  });
});

describe('contract calls', () => {
  const withdrawCalls = (program: unknown[] = [{ noop: { n: 1 } }]) => [
    { address: VAULT, entry: 'startWithdraw', program },
    { address: SINGLETON, entry: 'signBidirectional' },
  ];

  it('lists every call with its address and entry point, in order', () => {
    const s = summarise(decodeTransaction(callTx(withdrawCalls()).serialize(), 'unproven'));
    expect(s.intents).toBe(1);
    expect(s.calls.map((c) => [c.address, c.entryPoint])).toEqual([
      [VAULT, 'startWithdraw'],
      [SINGLETON, 'signBidirectional'],
    ]);
    expect(s.calls[0]!.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives equal digests to two builds of the same call (their communication randomness differs)', () => {
    const a = summarise(decodeTransaction(callTx(withdrawCalls()).serialize(), 'unproven'));
    const b = summarise(decodeTransaction(callTx(withdrawCalls()).serialize(), 'unproven'));
    expect(a.callsDigest).toBe(b.callsDigest);
    // (the zswap side of a real startWithdraw: the wallet's coin into the contract's output, balanced)
    const balanced = { ...a, guaranteed: { inputs: 1, outputs: 1, transients: 0 } };
    expect(detailOf(() => validateWithdraw(balanced, { calls: b.calls, callsDigest: b.callsDigest }, A))).toBe(
      'accepted',
    );
  });

  it('changes the digest when any disclosed value changes (another amount pushed, another program)', () => {
    const a = summarise(decodeTransaction(callTx(withdrawCalls([{ noop: { n: 1 } }])).serialize(), 'unproven'));
    const b = summarise(decodeTransaction(callTx(withdrawCalls([{ noop: { n: 2 } }])).serialize(), 'unproven'));
    expect(a.calls[0]!.digest).not.toBe(b.calls[0]!.digest);
    const balanced = { ...b, guaranteed: { inputs: 1, outputs: 1, transients: 0 } };
    expect(detailOf(() => validateWithdraw(balanced, { calls: a.calls, callsDigest: a.callsDigest }, A))).toBe(
      'wrong-call',
    );
  });

  it('masks only the callee commitment inside claimedContractCalls', () => {
    const call = (fr: number, entry = 'signBidirectional') => [
      {
        address: VAULT,
        entry: 'startWithdraw',
        effects: {
          // (the entry point as its 32-byte hash, the commitment as a field element's bytes)
          claimedContractCalls: [
            [0n, SINGLETON, createHash('sha256').update(entry).digest('hex'), new Uint8Array(32).fill(fr)],
          ],
        },
      },
    ];
    const a = summarise(decodeTransaction(callTx(call(1)).serialize(), 'unproven'));
    const b = summarise(decodeTransaction(callTx(call(2)).serialize(), 'unproven'));
    const c = summarise(decodeTransaction(callTx(call(1, 'respond')).serialize(), 'unproven'));
    expect(a.callsDigest).toBe(b.callsDigest);
    expect(a.callsDigest).not.toBe(c.callsDigest);
  });
});

describe('the callee commitment is masked where the program pushes it too (measured on the live vault)', () => {
  // Two builds of the vault's startWithdraw differ ONLY in the commitment to the singleton call: in
  // effects.claimedContractCalls[0][3] and in one pushed value (vault-keys.ts rebuild-check).
  const transcript = (fr: Uint8Array, pushed: Uint8Array) => ({
    gas: { readTime: 1n },
    effects: { claimedContractCalls: [[0n, SINGLETON, 'ab'.repeat(32), Uint8Array.from([0x73, ...fr])]] },
    program: [
      {
        push: {
          storage: false,
          value: { tag: 'cell', content: { value: [new Uint8Array([1]), pushed], alignment: [] } },
        },
      },
    ],
  });
  const digest = (t: unknown) =>
    callDigest({ address: VAULT, entryPoint: 'startWithdraw', guaranteedTranscript: t, fallibleTranscript: undefined });
  const fr1 = new Uint8Array(32).fill(0x11);
  const fr2 = new Uint8Array(32).fill(0x22);

  it('equal digests for two random commitments', () => {
    expect(digest(transcript(fr1, fr1))).toBe(digest(transcript(fr2, fr2)));
  });

  it('a pushed value that is not the commitment still counts', () => {
    expect(digest(transcript(fr1, new Uint8Array(32).fill(0x33)))).not.toBe(digest(transcript(fr1, fr1)));
  });
});

describe('canonical form', () => {
  it('orders map entries and object keys, and encodes bigints and bytes unambiguously', () => {
    const x = canonical({
      b: new Map([
        [2n, 'y'],
        [1n, 'x'],
      ]),
      a: new Uint8Array([1, 255]),
    });
    const y = canonical({
      a: new Uint8Array([1, 255]),
      b: new Map([
        [1n, 'x'],
        [2n, 'y'],
      ]),
    });
    expect(JSON.stringify(x)).toBe(JSON.stringify(y));
    expect(JSON.stringify(canonical(1n))).not.toBe(JSON.stringify(canonical('1')));
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

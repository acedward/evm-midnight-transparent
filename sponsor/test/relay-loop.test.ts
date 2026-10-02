// The sponsor's own relayer loop (sponsor/src/bridge/relay-loop.ts; audit C2): the MPC's signature,
// then the signed transfer broadcast AGAIN until it is mined or its nonce is consumed, then the
// attestation, every wait with a deadline. Driven here by a scripted chain on a virtual clock.

import { describe, expect, it } from 'vitest';

import { relayLoop, type RelayLoopIo } from '../src/bridge/relay-loop.js';
import type { RelayProgress } from '../src/swaps/backend.js';

const SIGNER = '0x648216975e722494bFF92E88FFc68C8F8d438FaA';
const SIGNED = {
  hash: `0x${'5a'.repeat(32)}`,
  from: SIGNER,
  nonce: 9,
  maxFeePerGas: 10_000_000_000n,
  serialized: '0x02f8',
};

interface Script {
  signedAfterMs?: number;
  minedAfterMs?: number | null;
  consumedAfterMs?: number | null;
  attestAfterMs?: number | null;
  attestKind?: 'success' | 'never-executed';
  broadcastError?: string;
}

function chain(script: Script) {
  const clock = { ms: 0 };
  const calls = { broadcasts: 0, receipts: 0 };
  const at = (t: number | null | undefined) => t !== null && t !== undefined && clock.ms >= t;
  const io: RelayLoopIo = {
    now: () => clock.ms,
    sleep: async (ms) => {
      clock.ms += ms;
    },
    log: () => undefined,
    signedTx: async () => (at(script.signedAfterMs ?? 0) ? SIGNED : undefined),
    receipt: async () => {
      calls.receipts++;
      return at(script.minedAfterMs) ? { hash: SIGNED.hash, blockNumber: 11_810_234, status: 1 } : null;
    },
    latestNonce: async () => (at(script.consumedAfterMs) || at(script.minedAfterMs) ? 10 : 9),
    broadcast: async () => {
      calls.broadcasts++;
      if (script.broadcastError) throw new Error(script.broadcastError);
    },
    finalizedBlock: async () => (at(script.minedAfterMs) ? 11_810_300 : 11_810_000),
    cachedOutput: async () => undefined,
    posts: async () => (at(script.attestAfterMs) ? [{ post: true }] : []),
    find: (_id, posts) =>
      posts.length > 0
        ? { kind: script.attestKind ?? 'success', bytes: new Uint8Array([1]), post: posts[0], origin: 'mpc-cache' }
        : undefined,
  };
  return { io, clock, calls };
}

const run = (io: RelayLoopIo, progress: RelayProgress[], over: Partial<Parameters<typeof relayLoop>[1]> = {}) =>
  relayLoop(io, {
    requestId: 'ab'.repeat(32),
    expectedSigner: SIGNER,
    signatureTimeoutMs: 20 * 60_000,
    attestationTimeoutMs: 33 * 60_000,
    intervalMs: 15_000,
    rebroadcastMs: 60_000,
    onProgress: (p) => progress.push(p),
    ...over,
  });

describe('the relay loop (audit C2)', () => {
  it('signed → broadcast → mined → final → attested, as the vendored relayer does', async () => {
    const { io, calls } = chain({ signedAfterMs: 30_000, minedAfterMs: 90_000, attestAfterMs: 17 * 60_000 });
    const progress: RelayProgress[] = [];
    const out = await run(io, progress);
    expect(out.kind).toBe('success');
    expect(out.evmTxHash).toBe(SIGNED.hash);
    expect(out.signedTxHash).toBe(SIGNED.hash);
    expect(progress.map((p) => p.stage)).toEqual(['signed', 'pending', 'broadcast', 'finalized', 'attested']);
    expect(calls.broadcasts).toBeGreaterThanOrEqual(1);
  });

  it('a transfer never mined and never replaced: broadcast again every minute, and the loop RETURNS at its deadline (no wait without one)', async () => {
    const { io, clock, calls } = chain({ signedAfterMs: 0, minedAfterMs: null, attestAfterMs: null });
    const progress: RelayProgress[] = [];
    await expect(run(io, progress)).rejects.toThrow(/waiting for the MPC's attestation.*not mined/);
    expect(clock.ms).toBeLessThanOrEqual(33 * 60_000 + 15_000);
    expect(calls.broadcasts).toBeGreaterThanOrEqual(30);
    expect(progress.map((p) => p.stage)).toEqual(['signed', 'pending']);
  });

  it('broadcast errors (already known, underpriced) do not end the loop', async () => {
    const { io } = chain({ minedAfterMs: 120_000, attestAfterMs: 600_000, broadcastError: 'already known' });
    const out = await run(io, []);
    expect(out.kind).toBe('success');
  });

  it('a nonce consumed by another transaction: not broadcast again, and the never-executed attestation is returned', async () => {
    const { io, calls } = chain({ consumedAfterMs: 45_000, attestAfterMs: 900_000, attestKind: 'never-executed' });
    const progress: RelayProgress[] = [];
    const out = await run(io, progress);
    expect(out.kind).toBe('never-executed');
    expect(out.evmTxHash).toBeUndefined();
    expect(progress.map((p) => p.stage)).toEqual(['signed', 'pending', 'not-broadcast', 'attested']);
    const before = calls.broadcasts;
    expect(before).toBeLessThanOrEqual(2);
  });

  it('no signature within the budget: the message the service recognises as an MPC timeout', async () => {
    const { io } = chain({ signedAfterMs: 10 ** 12 });
    await expect(run(io, [], { signatureTimeoutMs: 60_000 })).rejects.toThrow(
      /timed out after \d+ s waiting for the MPC's signature/,
    );
  });

  it('refuses a signature from another account', async () => {
    const { io } = chain({});
    await expect(run(io, [], { expectedSigner: '0x0000000000000000000000000000000000000001' })).rejects.toThrow(
      /signed as/,
    );
  });
});

// The sponsor's relayer loop for one vault request: the MPC's signature, the signed Sepolia transfer
// on chain, the MPC's attestation. It replaces the vendored `relayRequest` (./vendor/relayer.ts,
// kept byte for byte for its helpers: the signature reader, `findAttestation`) in ONE respect: no
// wait without a deadline (plan 00048 P4.2-fix, audit C2).
//
// Why: the vendored loop broadcasts once and then waits for the receipt with ethers' `wait(1)`,
// which has no timer; a transfer priced under a rising base fee, or dropped from the mempool, is
// never mined, so the call never returns. And the MPC does not help: it attests only a mined
// transaction (success or reverted) or one whose nonce another transaction consumed (never
// executed); a transfer that is simply never mined is never attested (sig-net/mpc @ e180584f,
// chain-signatures/node/src/indexer_eth.rs `process_block`; the plan's Evidence log, "C2 research").
//
// So this loop, after the signature:
//   - reads the receipt; while there is none and the sender's nonce is not past the transfer's, it
//     broadcasts the signed transfer AGAIN every `rebroadcastMs` (an EIP-1559 transaction never
//     expires: it is mined as soon as the base fee falls under its cap, if a node still has it);
//   - stops broadcasting once the nonce is consumed (by this transfer or a replacement);
//   - reports finality once the mined block is final (informative);
//   - polls the attestation, and gives up with an error after `attestationTimeoutMs` counted from
//     the signature: the caller records the request as stalled and drives it again later (the loop
//     is resumable by request id, as the vendored one: the signed transfer is re-read from the chain).
// Everything it touches is injected (`RelayLoopIo`), so it is tested on a virtual clock
// (sponsor/test/relay-loop.test.ts); ./live-backend.ts wires it to the chain.

import type { AttestedKind } from '../swaps/model.js';
import type { RelayProgress } from '../swaps/backend.js';

export interface SignedTransfer {
  hash: string;
  from: string;
  nonce: number;
  maxFeePerGas: bigint;
  /** The signed, serialised EIP-1559 transaction (0x…). */
  serialized: string;
}

export interface FoundAttestation {
  kind: AttestedKind;
  bytes: Uint8Array;
  post: unknown;
  origin: string;
}

export interface RelayLoopIo {
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** The MPC-signed transfer of the request, once its signature is posted (recovered to `expectedSigner`). */
  signedTx(requestId: string, expectedSigner: string): Promise<SignedTransfer | undefined>;
  receipt(hash: string): Promise<{ hash: string; blockNumber: number; status: number | null } | null>;
  /** The sender's mined transaction count. */
  latestNonce(address: string): Promise<number>;
  broadcast(serialized: string): Promise<void>;
  finalizedBlock(): Promise<number | null>;
  cachedOutput(requestId: string): Promise<Uint8Array | undefined>;
  posts(requestId: string): Promise<readonly unknown[]>;
  find(requestId: string, posts: readonly unknown[], cached: Uint8Array | undefined): FoundAttestation | undefined;
}

export interface RelayLoopOptions {
  requestId: string;
  expectedSigner: string;
  signatureTimeoutMs: number;
  /** Counted from the signature. */
  attestationTimeoutMs: number;
  intervalMs: number;
  rebroadcastMs: number;
  onProgress: (p: RelayProgress) => void;
}

export interface RelayLoopResult {
  kind: AttestedKind;
  serializedOutput: Uint8Array;
  post: unknown;
  outputOrigin: string;
  evmTxHash?: string;
  signedTxHash: string;
  signatureAfterMs: number;
  attestationAfterMs: number;
}

const message = (e: unknown) => String((e as Error)?.message ?? e);

export async function relayLoop(io: RelayLoopIo, o: RelayLoopOptions): Promise<RelayLoopResult> {
  const started = io.now();
  const elapsed = () => io.now() - started;

  // ---- 1. the MPC's signature over the transfer ----------------------------------------
  let signed: SignedTransfer | undefined;
  while (signed === undefined) {
    if (elapsed() > o.signatureTimeoutMs) {
      throw new Error(
        `timed out after ${Math.round(elapsed() / 1000)} s waiting for the MPC's signature on ` +
          `${o.requestId} (expected signer ${o.expectedSigner})`,
      );
    }
    try {
      signed = await io.signedTx(o.requestId, o.expectedSigner);
    } catch (e) {
      io.log(`signature poll failed (retrying): ${message(e)}`);
    }
    if (signed === undefined) await io.sleep(o.intervalMs);
  }
  if (signed.from.toLowerCase() !== o.expectedSigner.toLowerCase()) {
    throw new Error(`the MPC signed as ${signed.from}, expected the derived account ${o.expectedSigner}`);
  }
  const signatureAfterMs = elapsed();
  o.onProgress({
    stage: 'signed',
    signedTxHash: signed.hash,
    from: signed.from,
    nonce: signed.nonce,
    afterMs: signatureAfterMs,
    maxFeePerGas: signed.maxFeePerGas,
  });

  // ---- 2 and 3. on chain, then the attestation, every wait bounded -----------------------
  const signedAt = io.now();
  let mined: { hash: string; blockNumber: number; status: number | null } | undefined;
  let consumed = false;
  let lastBroadcast = Number.NEGATIVE_INFINITY;
  let pendingReported = false;
  let finalReported = false;
  for (;;) {
    if (mined === undefined && !consumed) {
      const receipt = await io.receipt(signed.hash).catch(() => null);
      if (receipt !== null) {
        mined = receipt;
        o.onProgress({
          stage: 'broadcast',
          evmTxHash: receipt.hash,
          evmBlock: receipt.blockNumber,
          evmStatus: receipt.status ?? undefined,
          alreadyMined: lastBroadcast === Number.NEGATIVE_INFINITY,
          afterMs: elapsed(),
        });
      } else {
        const latest = await io.latestNonce(signed.from).catch(() => null);
        if (latest !== null && latest > signed.nonce) {
          // Another transaction took the nonce: this transfer can never be mined; the MPC will
          // attest it never executed.
          consumed = true;
          o.onProgress({
            stage: 'not-broadcast',
            reason: `nonce ${signed.nonce} already consumed (account nonce ${latest}); not broadcasting`,
            afterMs: elapsed(),
          });
        } else if (io.now() - lastBroadcast >= o.rebroadcastMs) {
          try {
            await io.broadcast(signed.serialized);
          } catch (e) {
            // "already known", "replacement transaction underpriced", a fee under the base fee:
            // the node has it or will not take it now; try again later.
            io.log(`broadcast of ${signed.hash} refused (will retry): ${message(e)}`);
          }
          lastBroadcast = io.now();
          if (!pendingReported) {
            pendingReported = true;
            o.onProgress({ stage: 'pending', signedTxHash: signed.hash, nonce: signed.nonce, afterMs: elapsed() });
          }
        }
      }
    }
    if (mined !== undefined && !finalReported) {
      const finalized = await io.finalizedBlock().catch(() => null);
      if (finalized !== null && finalized >= mined.blockNumber) {
        finalReported = true;
        o.onProgress({
          stage: 'finalized',
          evmBlock: mined.blockNumber,
          finalizedBlock: finalized,
          afterMs: elapsed(),
        });
      }
    }
    const cached = await io.cachedOutput(o.requestId).catch(() => undefined);
    const posts = await io.posts(o.requestId).catch((e: unknown) => {
      io.log(`attestation poll failed (retrying): ${message(e)}`);
      return [] as readonly unknown[];
    });
    const found = io.find(o.requestId, posts, cached);
    if (found !== undefined) {
      const attestationAfterMs = elapsed();
      o.onProgress({ stage: 'attested', kind: found.kind, outputOrigin: found.origin, afterMs: attestationAfterMs });
      return {
        kind: found.kind,
        serializedOutput: found.bytes,
        post: found.post,
        outputOrigin: found.origin,
        ...(mined ? { evmTxHash: mined.hash } : {}),
        signedTxHash: signed.hash,
        signatureAfterMs,
        attestationAfterMs,
      };
    }
    if (io.now() - signedAt > o.attestationTimeoutMs) {
      throw new Error(
        `timed out ${Math.round((io.now() - signedAt) / 1000)} s after the signature waiting for the MPC's ` +
          `attestation on ${o.requestId}` +
          (mined
            ? ''
            : consumed
              ? ' (its nonce was consumed by another transaction)'
              : ' (the transfer is not mined yet)'),
      );
    }
    await io.sleep(o.intervalMs);
  }
}

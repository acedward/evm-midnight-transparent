// L-WALLET's local proving check (not CI): what the wallet sends to the sponsor's `/prove` is
// provable the way the sponsor proves it, and the wallet's finalizers accept what comes back.
//
//   bash packages/wallet/test/proving/run.sh     (a Docker proof server; the vault's compiled keys)
//
// No network but the local proof server; nothing is submitted. It uses the unit tests' offline
// doubles: a wallet whose shielded state holds chosen coins (never on chain) and the vault state
// recorded at block 679,357.
//   take      buildTake (the G-TAKE offer) → hex → the SDK's server proving service (G-TAKE's path,
//             the proof server's built-in zswap keys) → pre-binding hex → finalizeTake.
//   withdraw  buildWithdraw (G-BRIDGE B.3.1's arguments) → hex → midnight-js httpClientProofProvider
//             with the vault's key directory (G-BRIDGE's path) → pre-binding hex → finalizeWithdraw.
// Both check that proving kept every identifier of the draft (the finalizers rely on it).

import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { nodeZkConfigRegistry } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { makeServerProvingService } from '@midnightntwrk/wallet-sdk-capabilities/proving';

import {
  buildTake,
  buildWithdraw,
  finalizeTake,
  finalizeWithdraw,
  provenFromHex,
  provenUnboundFromHex,
  txToHex,
  unprovenFromHex,
} from '../../src/index.js';
import {
  TEST_SEED_A,
  TEST_SEED_B,
  WSTKA,
  fixture,
  fixtureReader,
  walletWithCoins,
  type VaultFixture,
} from '../helpers.js';

const PROOF = process.env.PROOF_SERVER_URL ?? 'http://aa00048-lw-prover:6300';
const MANAGED = process.env.VAULT_MANAGED_DIR ?? '/managed';
const OUT = process.env.EVIDENCE_DIR ?? '/out';

const say = (msg: string, fields: Record<string, unknown> = {}) =>
  process.stderr.write(`[l-wallet-prove ${new Date().toISOString()}] ${msg} ${JSON.stringify(fields)}\n`);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  if (!ok) failures.push(what);
};
const ms = (t: number) => Math.round(performance.now() - t);

async function takeCheck() {
  const offer = fixture<{ offerId: string; offerBech32: string }>('stagenet-bid-9ed57eec.json');
  const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: 104_166_667n }]);
  const draft = await buildTake(wallet, offer.offerBech32);
  const t0 = performance.now();
  const proven = await makeServerProvingService({ provingServerUrl: new URL(PROOF) }).prove(unprovenFromHex(draft.tx));
  const proveMs = ms(t0);
  const provenHex = txToHex(proven);
  provenUnboundFromHex(provenHex); // the wire form /prove returns: proven, pre-binding
  const ids = new Set(proven.identifiers().map(String));
  check(
    draft.identifiers.every((id) => ids.has(id)),
    'take: proving kept the identifiers',
  );
  const settlement = finalizeTake(draft, provenHex);
  const bound = provenFromHex(settlement.tx).tx;
  check(bound.identifiers().length >= draft.identifiers.length, 'take: the settlement carries both sides');
  await wallet.close();
  return {
    proveMs,
    provenBytes: provenHex.length / 2,
    settlementBytes: settlement.txBytes,
    identifiers: draft.identifiers.length,
  };
}

async function withdrawCheck() {
  const f = fixture<VaultFixture>('stagenet-vault-679357.json');
  const wallet = await walletWithCoins(TEST_SEED_B, [{ colour: WSTKA, value: 1_000_000n }]);
  const draft = await buildWithdraw(
    wallet,
    { colour: WSTKA, amount: 1_000_000n, dest: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b', evmNonce: 9n },
    { reader: fixtureReader(f) },
  );
  check(
    draft.requestId === '21d8b43db31bc94cc782eb460fc5cf2cf260fbeffe44938606f6b75660822900',
    'withdraw: the G-BRIDGE request id',
  );
  const registry = await nodeZkConfigRegistry(MANAGED);
  const t0 = performance.now();
  const proven = await httpClientProofProvider(PROOF, registry as never).proveTx(unprovenFromHex(draft.tx) as never);
  const proveMs = ms(t0);
  const provenHex = txToHex(proven as { serialize(): Uint8Array });
  provenUnboundFromHex(provenHex);
  const fin = finalizeWithdraw(draft, provenHex);
  const bound = provenFromHex(fin.tx);
  check(bound.wasBound, 'withdraw: finalize gives a bound transaction');
  // An already-bound answer is accepted too.
  const again = finalizeWithdraw(draft, fin.tx);
  check(again.tx === fin.tx, 'withdraw: a bound answer passes unchanged');
  await draft.release();
  await wallet.close();
  return { proveMs, provenBytes: provenHex.length / 2, boundBytes: fin.txBytes, identifiers: draft.identifiers.length };
}

async function main() {
  const version = await fetch(`${PROOF}/version`).then((r) => r.text());
  say('proof server', { url: PROOF, version: version.slice(0, 40) });
  const take = await takeCheck();
  say('take proven and finalized', take);
  const withdraw = await withdrawCheck();
  say('withdraw proven and finalized', withdraw);
  const evidence = {
    lane: 'L-WALLET',
    plan: '00048',
    step: 'proving-check',
    at: new Date().toISOString(),
    proofServer: { version: version.slice(0, 40) },
    pass: failures.length === 0,
    failures,
    take,
    withdraw,
  };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, 'proving-check.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  say(failures.length === 0 ? 'PASS' : 'FAIL', { failures });
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  say('FAILED', { error: String((e as Error)?.stack ?? e).slice(0, 2000) });
  process.exit(1);
});

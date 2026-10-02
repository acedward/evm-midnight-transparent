// Plan 00048 P4.2-live (E.5): the T1 CONTAINMENT griefer. It reuses the G-BRIDGE bridge code
// (sponsor/src/bridge/*) to complete a swap's OWN deposit request before the sponsor does, sealing
// the minted coin to a DIFFERENT encryption key with a mint nonce only this script knows. The coin
// is then owned by the swap's temporary coin key but can never be seen or spent by it (questions
// file Q16): the amount is lost by design. This drives the sponsor's containment (audit T1): the
// sponsor must resolve its gone request as `settled-elsewhere` and never retry the settle.
//
// It pays DUST from the SAME sponsor seed (`.stagenet`), under the funding lock that run-live.sh
// holds; the sponsor container is stopped while this runs, so only this process uses the wallet.
// Secrets are read in-process only and never printed. Inputs (public): the swap's temporary coin
// public key and its deposit address — it finds the open deposit request for that recipient itself.
//
//   bun test/live/griefer.ts --temp-coin-pk <64hex> --deposit-address <0x…> [--token stkA] [--name e5-grief]

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import * as Rx from 'rxjs';

import { STAGENET, depositPathOf, stagenetRegistry, walletRecipient } from '@evm-midnight-transparent/core';
import { temporaryWalletKeys } from '@evm-midnight-transparent/wallet';
import vaultRecord from '../../packages/core/src/tokens/deployments/stagenet-vault.json';
import { openFacadeWallet, type OpenedWallet } from '../../sponsor/src/sponsor/facade.js';
import { parseSponsorSeed } from '../../sponsor/src/config.js';
import {
  loadVault,
  openRequests,
  publicDataProviderFor,
  settle,
  sponsorProviders,
  type VaultEndpoints,
} from '../../sponsor/src/bridge/vault.js';
import { relayRequest, type RelayProgress } from '../../sponsor/src/bridge/vendor/relayer.js';
import {
  bytesToHex,
  deriveMidnightResponseKey,
  normaliseSecp256k1PublicKey,
} from '../../sponsor/src/bridge/vendor/signet-sdk.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const NETWORK_ID = 'stagenet';
const VAULT = vaultRecord.vaultContractAddress;
const SINGLETON = vaultRecord.signetSingleton;
const MPC_ROOT = normaliseSecp256k1PublicKey(vaultRecord.mpcRootPublicKey);
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const PROOF_SERVER_URL = process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300';
const FEE_BLOCKS_MARGIN = Number(process.env.FEE_BLOCKS_MARGIN ?? '20');
const MANAGED_DIR = process.env.VAULT_MANAGED_DIR ?? '';
const EVIDENCE_DIR = process.env.GRIEF_EVIDENCE_DIR ?? '';

const ENDPOINTS: VaultEndpoints = {
  networkId: NETWORK_ID,
  indexerUrl: STAGENET.midnight.indexerUrl,
  indexerWsUrl: STAGENET.midnight.indexerWsUrl,
  proofServerUrl: PROOF_SERVER_URL,
};

const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);
const strip0x = (h: string) => h.replace(/^0x/i, '').toLowerCase();
const normHex = (v: unknown): string =>
  v instanceof Uint8Array ? Buffer.from(v).toString('hex') : String(v).replace(/^0x/i, '').toLowerCase();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function setNetwork() {
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId(NETWORK_ID as never);
}

async function openSponsor(): Promise<{ opened: OpenedWallet; cpk: string; epk: string }> {
  const file = process.env.STAGENET_WALLET_FILE ?? '/secrets/stagenet';
  const seedHex = parseSponsorSeed(readFileSync(file, 'utf8'));
  const opened = await openFacadeWallet(
    seedHex,
    { ...ENDPOINTS, nodeWsUrl: STAGENET.midnight.nodeWsUrl },
    { feeBlocksMargin: FEE_BLOCKS_MARGIN },
  );
  const wallet = (opened.handle as Any).wallet;
  const t0 = Date.now();
  const synced: Any = await Rx.firstValueFrom(
    (wallet.state() as Rx.Observable<Any>).pipe(
      Rx.throttleTime(5_000),
      Rx.filter((st: Any) => st.isSynced === true),
    ),
  );
  log(`sponsor seed (DUST payer) synced in ${Math.round((Date.now() - t0) / 1000)} s`);
  return {
    opened,
    cpk: synced.shielded.coinPublicKey.toHexString(),
    epk: synced.shielded.encryptionPublicKey.toHexString(),
  };
}

/** A fresh, valid griefer encryption public key from a random seed (the SECRET seed never leaves
 *  this process and is cleared at once; only the public key is used). */
function grieferEncKey(): string {
  const seedHex = randomBytes(32).toString('hex');
  const keys = temporaryWalletKeys(seedHex, NETWORK_ID);
  const encPk = keys.encryptionPublicKey;
  keys.clear();
  return encPk;
}

function saveEvidence(name: string, value: unknown) {
  if (!EVIDENCE_DIR) return;
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    path.join(EVIDENCE_DIR, `${name}.json`),
    `${JSON.stringify({ plan: '00048 P4.2-live E.5 griefer', ...(value as object), writtenUtc: new Date().toISOString() }, null, 2)}\n`,
  );
}

async function main() {
  await setNetwork();
  if (!MANAGED_DIR) throw new Error('VAULT_MANAGED_DIR is not set');
  const tempCoinPk = strip0x(arg('temp-coin-pk') ?? process.env.GRIEF_TEMP_COIN_PK ?? '');
  const depositAddress = arg('deposit-address') ?? process.env.GRIEF_DEPOSIT_ADDRESS ?? '';
  const name = arg('name') ?? 'e5-grief';
  const symbol = arg('token') ?? 'stkA';
  if (!/^[0-9a-f]{64}$/.test(tempCoinPk)) throw new Error('--temp-coin-pk must be 64 hex');
  if (!/^0x[0-9a-fA-F]{40}$/.test(depositAddress)) throw new Error('--deposit-address must be a 0x EVM address');
  const token = stagenetRegistry().bySymbol(symbol);
  if (!token) throw new Error(`unknown token ${symbol}`);

  const expectedPath = bytesToHex(depositPathOf(walletRecipient(tempCoinPk)));
  log(`griefing the deposit of temp coin pk ${tempCoinPk.slice(0, 12)}… (path ${expectedPath.slice(0, 12)}…)`);

  const rt = await loadVault(MANAGED_DIR);
  const pdp = await publicDataProviderFor(ENDPOINTS);
  const ledgerState = (await pdp.queryContractState(VAULT)).data;
  const reqs = await openRequests(rt, ledgerState, 'deposit');
  const mine = [...reqs.entries()].filter(([, r]) => normHex(r.path) === expectedPath);
  if (mine.length !== 1)
    throw new Error(`expected exactly one open deposit request for the path, found ${mine.length}`);
  const [requestId, record] = mine[0]!;
  log(`found the swap's open deposit request ${requestId} (nonce ${String(record.requestNonce)})`);

  // Relay it ourselves to get the attestation (and broadcast the sweep if the sponsor has not).
  const sp = await openSponsor();
  try {
    const providers = await sponsorProviders(rt, sp.opened, ENDPOINTS, sp.cpk, sp.epk);
    const relay = await relayRequest({
      publicDataProvider: pdp,
      indexerUrl: ENDPOINTS.indexerUrl,
      requesterContractAddress: VAULT,
      requesterRequestsPath: [0],
      signetContractAddress: SINGLETON,
      requestId,
      expectedSigner: depositAddress,
      mpcResponseKey: deriveMidnightResponseKey(MPC_ROOT, VAULT) as never,
      responseSchema: rt.pureCircuits.vaultResponseSchema(),
      evmRpcUrl: SEPOLIA_RPC_URL,
      outputCache: { networkId: NETWORK_ID, cacheUrl: vaultRecord.mpcOutputCacheUrl },
      intervalMs: 15_000,
      onProgress: (p: RelayProgress) =>
        log(
          `relay: ${p.stage}${'signedTxHash' in p ? ` ${p.signedTxHash}` : ''}${'evmTxHash' in p ? ` ${p.evmTxHash}` : ''}`,
        ),
      log,
    });
    log(`relay finished: attestation ${relay.kind}, sweep ${relay.evmTxHash ?? '(cached)'}`);
    if (relay.kind !== 'success') throw new Error(`the deposit attested ${relay.kind}: not griefing a non-success`);

    const encPk = grieferEncKey();
    log(`completing the deposit with a DIFFERENT encryption key ${encPk.slice(0, 12)}… and a random mint nonce`);
    const out = await settle(providers, rt, VAULT, 'completeDeposit', {
      requestId,
      event: (relay as Any).event,
      serializedOutput: relay.serializedOutput,
      recipientCoinPublicKeyHex: tempCoinPk,
      recipientEncryptionPublicKeyHex: encPk,
    });
    const minted = out.minted
      ? { nonce: bytesToHex(out.minted.nonce), color: bytesToHex(out.minted.color), value: String(out.minted.value) }
      : null;
    log(`griefer completeDeposit landed: tx ${out.txHash ?? out.txId} (${out.status}); minted ${minted?.value ?? '?'}`);
    saveEvidence(name, {
      requestId,
      tempCoinPk,
      depositAddress,
      token: token.symbol,
      payColour: token.midnightColour,
      grieferEncryptionPublicKey: encPk,
      sweepTx: relay.evmTxHash ?? null,
      completeDeposit: { txId: out.txId, txHash: out.txHash, blockHeight: out.blockHeight, status: out.status },
      mintedCoin: minted,
      note: 'the minted coin is owned by the swap temp coin key but sealed to the griefer enc key with a nonce only the griefer knows: unrecoverable (Q16)',
    });
  } finally {
    await sp.opened.stop();
  }
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error(`griefer failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);

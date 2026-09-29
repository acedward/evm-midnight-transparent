/* eslint-disable @typescript-eslint/no-explicit-any -- the wallet SDK facade used for the funding
   transfer is loaded at run time and its surface is untyped here on purpose (this file never runs
   in CI). */
// G-TAKE (plan 00048, P1): can a temporary Midnight wallet, derived from an EVM signature, take a
// live stagenet ladder offer through the exchange's batcher, holding no DUST?
//
// Commands (run-gate.sh runs them in Docker, one per run):
//   derive                 T.1 live: sign "start swap" twice with the test EVM key, assert the two
//                          signatures are equal, derive the temporary wallet (public keys printed)
//   fund <offerId>         T.2: the funding wallet sends the temporary wallet EXACTLY the offer's
//                          wanted amount (shielded). run-gate.sh holds the shared funding lock
//   take <offerId>         T.3 + T.4: sync (timed), re-check /status, balance the shielded side,
//                          prove (timed), submit to the batcher (timed), then assert the offer is
//                          consumed by our transaction and the wallet received the maker's leg
//   measure-sync           T.4: a FRESH random seed's shielded-only sync time (then discarded)
//   status                 the temporary wallet's balances (read-only)
//
// SECRETS. The test EVM key (`.sepolia`, SK=) and the funding wallet (`.stagenet`, WALLET=) are
// mounted read-only and read in-process only; nothing secret is ever printed, logged or written.
// The temporary wallet's seed is re-derived on every run by signing again (the salt is public and
// kept in STATE_DIR). Evidence files carry public values only.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { inspect } from 'node:util';

import { Wallet } from 'ethers';

import {
  STAGENET,
  bytesToHex,
  deriveSwapSeed,
  newSwapSalt,
  offerIdOf,
  submitToBatcher,
  type StartSwapSigner,
} from '../../../packages/core/src/index.js';
import {
  buildTake,
  decodeMakerTransaction,
  openShieldedWallet,
  serverProvingService,
  takeTerms,
  temporaryWalletKeys,
  type TemporaryWalletKeys,
} from '../../../packages/wallet/src/index.js';
import { parseSponsorSeed } from '../../../sponsor/src/config.js';
import { openFacadeWallet } from '../../../sponsor/src/sponsor/facade.js';

// ---- configuration (public values) ---------------------------------------------------------------

const env = (k: string, d: string) => process.env[k] || d;
const OUT = env('GATE_EVIDENCE_DIR', '/out');
const STATE_DIR = env('GATE_STATE_DIR', '/state');
const STATE_FILE = path.join(STATE_DIR, 'g-take-state.json');
const SEPOLIA_SECRET = env('SEPOLIA_SECRET_FILE', '/run/secrets/sepolia');
const STAGENET_SECRET = env('STAGENET_SECRET_FILE', '/run/secrets/stagenet');
const PROOF = env('PROOF_SERVER_URL', 'http://aa00048-gt-prover:6300');
const NET = STAGENET;
const NETWORK_ID = NET.midnightNetworkId;
const KERNEL = NET.zswap.kernelUrl;
const BATCHER = NET.zswap.batcherUrl;
const INDEXER = NET.midnight.indexerUrl;
const VAULT = NET.bridge.vaultAddress;
/** The test EVM user (plan header): 0x4847…e56b. */
const EXPECTED_EVM_PREFIX = '0x4847';
const EXPECTED_EVM_SUFFIX = 'e56b';
/** Q8 A: ≤ 100 DUST per run (1 DUST = 10^15 specks). */
const DUST_CAP_SPECKS = 100n * 10n ** 15n;
const FEE_BLOCKS_MARGIN = Number(env('FEE_BLOCKS_MARGIN', '5'));

const say = (msg: string, fields: Record<string, unknown> = {}) =>
  process.stderr.write(
    `[g-take ${new Date().toISOString()}] ${msg}${Object.keys(fields).length ? ` ${JSON.stringify(jsonSafe(fields))}` : ''}\n`,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secondsSince = (t: number) => Math.round((performance.now() - t) / 100) / 10;

function jsonSafe(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (_k, x) =>
      typeof x === 'bigint' ? x.toString(10) : x instanceof Uint8Array ? bytesToHex(x) : x,
    ),
  );
}

function writeEvidence(name: string, body: Record<string, unknown>): void {
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(jsonSafe({ gate: 'G-TAKE', plan: '00048', step: name, at: new Date().toISOString(), ...body }), null, 2)}\n`,
  );
  say('evidence written', { file: path.basename(file) });
}

/** A balance by colour, whatever the SDK's key spelling (0x or not, any case). */
const balanceOf = (balances: Record<string, bigint>, colour: string): bigint => {
  const want = colour.replace(/^0x/, '').toLowerCase();
  for (const [k, v] of Object.entries(balances)) if (k.replace(/^0x/, '').toLowerCase() === want) return v;
  return 0n;
};

const errorChain = (e: unknown): string => {
  const parts: string[] = [];
  let cur: any = e;
  for (let i = 0; i < 8 && cur; i++) {
    parts.push(String(cur?.message ?? cur));
    cur = cur?.cause;
  }
  return parts.join(' <- ');
};

// ---- state (public values only; STATE_DIR is ~/.config/aa-00048, mode 700) -------------------------

interface GateState {
  /** The swap's salt (public). */
  salt?: string;
  /** The one offer this gate funds and takes. */
  offerId?: string;
  fundingTx?: { identifier: string; hash?: string };
  /** Funding attempts that never reached the chain (checked again before every new attempt). */
  abandonedFunding?: { identifier: string; reason: string }[];
  takeTx?: string;
}
function loadState(): GateState {
  return existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as GateState) : {};
}
function saveState(s: GateState): void {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
}

// ---- secrets (read in-process, never printed) ----------------------------------------------------

function sepoliaKey(): string {
  const text = readFileSync(SEPOLIA_SECRET, 'utf8');
  let value = text.trim();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(SK|PRIVATE_KEY)\s*=\s*(.*)$/.exec(line);
    if (m) value = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
  }
  const hex = value.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('the Sepolia secret file does not hold a 32-byte key');
  return `0x${hex}`;
}

// ---- T.1: the temporary wallet from two signatures ------------------------------------------------

interface Derived {
  keys: TemporaryWalletKeys;
  signer: string;
  deterministic: boolean;
  prompts: number;
  salt: string;
}

async function deriveTemporaryWallet(): Promise<Derived> {
  const state = loadState();
  if (!state.salt) {
    state.salt = newSwapSalt();
    saveState(state);
    say('new swap salt saved', { salt: state.salt });
  }
  const evm = new Wallet(sepoliaKey());
  const addr = evm.address.toLowerCase();
  if (!addr.startsWith(EXPECTED_EVM_PREFIX) || !addr.endsWith(EXPECTED_EVM_SUFFIX)) {
    throw new Error(`the Sepolia key is not the test user's (${evm.address})`);
  }
  let prompts = 0;
  const sign: StartSwapSigner = async (td) => {
    prompts += 1;
    const { EIP712Domain: _domain, ...types } = td.types;
    return evm.signTypedData(td.domain, types, td.message);
  };
  const out = await deriveSwapSeed(sign, { network: NETWORK_ID, vault: VAULT, salt: state.salt }, evm.address);
  const keys = temporaryWalletKeys(out.seedHex, NETWORK_ID);
  return { keys, signer: out.signer, deterministic: out.deterministic, prompts, salt: state.salt };
}

function publicKeys(k: TemporaryWalletKeys) {
  return {
    coinPublicKey: k.coinPublicKey,
    encryptionPublicKey: k.encryptionPublicKey,
    shieldedAddress: k.shieldedAddress,
    unshieldedAddress: k.unshieldedAddress,
  };
}

async function cmdDerive(): Promise<void> {
  const d = await deriveTemporaryWallet();
  const again = await deriveTemporaryWallet();
  const sameWallet = again.keys.coinPublicKey === d.keys.coinPublicKey;
  const result = {
    signer: d.signer,
    signaturePrompts: d.prompts,
    signaturesEqual: d.deterministic,
    reDerivedSameWallet: sameWallet,
    network: NETWORK_ID,
    vault: VAULT,
    salt: d.salt,
    temporaryWallet: publicKeys(d.keys),
    pass: d.deterministic && again.deterministic && sameWallet && d.prompts === 2,
  };
  writeEvidence('t1-derive', result);
  say('T.1 derive', result);
  d.keys.clear();
  again.keys.clear();
  if (!result.pass) throw new Error('T.1 FAILED: the signatures differ or the wallet changed');
}

// ---- the kernel -----------------------------------------------------------------------------------

async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body };
}

async function offerStatus(offerId: string): Promise<string> {
  const r = await getJson(`${KERNEL}/v1/offers/${offerId}/status`);
  if (r.status !== 200) throw new Error(`kernel status ${r.status}: ${JSON.stringify(r.body)}`);
  return String(r.body.status);
}

async function fetchOffer(offerId: string): Promise<{ offerBech32: string; computed: any }> {
  const r = await getJson(`${KERNEL}/v1/offers/${offerId}`);
  if (r.status !== 200) throw new Error(`kernel offer ${r.status}: ${JSON.stringify(r.body)}`);
  return { offerBech32: String(r.body.offerBech32), computed: r.body.computed };
}

// ---- the indexer ----------------------------------------------------------------------------------

async function gql(query: string, variables: Record<string, unknown>): Promise<any> {
  const r = await getJson(INDEXER, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (r.status !== 200 || r.body?.errors)
    throw new Error(`indexer ${r.status}: ${JSON.stringify(r.body?.errors ?? r.body)}`);
  return r.body.data;
}

const TX_FIELDS = `hash block { height timestamp }
  ... on RegularTransaction { identifiers fee transactionResult { status } }`;

async function txBy(offset: { hash?: string; identifier?: string }, timeoutMs = 300_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const data = await gql(`query($o: TransactionOffset!) { transactions(offset: $o) { ${TX_FIELDS} } }`, {
      o: offset,
    });
    const t = (data?.transactions ?? [])[0];
    if (t) return t;
    if (Date.now() > deadline) throw new Error(`the indexer has no transaction ${JSON.stringify(offset)}`);
    await sleep(4000);
  }
}

// ---- the funding wallet (T.2) ---------------------------------------------------------------------

async function cmdFund(offerId: string): Promise<void> {
  const state = loadState();
  if (state.offerId && state.offerId !== offerId && state.fundingTx) {
    throw new Error(`this gate already funded offer ${state.offerId}; one offer per gate`);
  }
  if (state.fundingTx) throw new Error('the temporary wallet was already funded; refusing to fund twice');
  for (const a of state.abandonedFunding ?? []) {
    const landed = await gql(`query($o: TransactionOffset!) { transactions(offset: $o) { hash } }`, {
      o: { identifier: a.identifier },
    });
    if ((landed?.transactions ?? []).length > 0)
      throw new Error(`an abandoned funding attempt landed: ${a.identifier}`);
  }
  const d = await deriveTemporaryWallet();
  if (!d.deterministic) throw new Error('the test signer is not deterministic');
  const status = await offerStatus(offerId);
  if (status !== 'live') throw new Error(`offer ${offerId} is ${status}`);
  const offer = await fetchOffer(offerId);
  const makerTx = decodeMakerTransaction(offer.offerBech32);
  if (offerIdOf(makerTx.serialize()) !== offerId) throw new Error('the kernel served bytes for another offer');
  const terms = takeTerms(makerTx);
  if (terms.give.length !== 1) throw new Error('only a one-leg offer is funded');
  const leg = terms.give[0]!;
  say('funding the temporary wallet', { offerId, colour: leg.colour, amount: leg.amount, to: d.keys.shieldedAddress });

  const seedHex = parseSponsorSeed(readFileSync(STAGENET_SECRET, 'utf8'));
  const t0 = performance.now();
  const opened = await openFacadeWallet(
    seedHex,
    {
      networkId: NETWORK_ID,
      indexerUrl: NET.midnight.indexerUrl,
      indexerWsUrl: NET.midnight.indexerWsUrl,
      nodeWsUrl: NET.midnight.nodeWsUrl,
      proofServerUrl: PROOF,
    },
    { feeBlocksMargin: FEE_BLOCKS_MARGIN },
  );
  const h = opened.handle as { wallet: any; shieldedSecretKeys: any; dustSecretKey: any; unshieldedKeystore: any };
  try {
    const synced = await h.wallet.waitForSyncedState();
    const syncSeconds = secondsSince(t0);
    const before = {
      colour: balanceOf(synced.shielded.balances, leg.colour),
      dust: synced.dust.balance(new Date()) as bigint,
    };
    say('funding wallet synced', { seconds: syncSeconds, holds: before.colour, dustSpecks: before.dust });
    if (before.colour < leg.amount) throw new Error('the funding wallet does not hold the wanted amount');

    // Built from the two public keys, not parsed: the SDK's `MidnightBech32m.parse` refuses a shielded
    // address (133 characters) under @scure/base 2.4's default 90-character bech32 limit.
    const { ShieldedAddress, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey } =
      await import('@midnightntwrk/wallet-sdk-address-format');
    const receiver = new ShieldedAddress(
      ShieldedCoinPublicKey.fromHexString(d.keys.coinPublicKey),
      ShieldedEncryptionPublicKey.fromHexString(d.keys.encryptionPublicKey),
    );
    const ttl = new Date(Date.now() + 30 * 60_000);
    const recipe = await h.wallet.transferTransaction(
      [{ type: 'shielded', outputs: [{ type: leg.colour, receiverAddress: receiver, amount: leg.amount }] }],
      { shieldedSecretKeys: h.shieldedSecretKeys, dustSecretKey: h.dustSecretKey },
      { ttl, payFees: true },
    );
    // Sign (a no-op for a shielded transfer, kept for parity with the funding tools), then prove.
    const signed = await h.wallet.signRecipe(recipe, async (data: Uint8Array) => h.unshieldedKeystore.signData(data));
    const t1 = performance.now();
    const finalized = await h.wallet.finalizeRecipe(signed);
    const provingSeconds = secondsSince(t1);
    const identifier = String(finalized.identifiers().at(-1));
    state.offerId = offerId;
    state.fundingTx = { identifier };
    saveState(state);
    say('funding transaction proven; submitting', { identifier, provingSeconds });
    const t2 = performance.now();
    // The node's Finalized notice can go missing although the transaction is included (the ladder
    // tools' P12 note): whichever comes first, the submission or the indexer's record, wins.
    const submitted: Promise<unknown> = h.wallet.submitTransaction(finalized);
    const viaSubmit = submitted.then(() => txBy({ identifier }));
    // The indexer branch can only resolve: a failed lookup never ends the race early.
    const viaIndexer = txBy({ identifier }, 15 * 60_000).catch(() => new Promise<never>(() => undefined));
    let tx: any;
    try {
      tx = await Promise.race([viaSubmit, viaIndexer]);
    } catch (e) {
      writeEvidence('t2-fund-refused', { offerId, identifier, error: errorChain(e) });
      throw new Error(`REFUSED: the node refused the funding transfer: ${errorChain(e)}`, { cause: e });
    }
    const submitSeconds = secondsSince(t2);
    state.fundingTx.hash = String(tx.hash);
    saveState(state);
    const feeSpecks = BigInt(tx.fee ?? 0);
    if (feeSpecks > DUST_CAP_SPECKS) throw new Error(`the funding fee ${feeSpecks} is over the DUST cap`);
    // The funding wallet's balance after the transfer (its own view, once it has seen the tx).
    let after = before.colour;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const s = await h.wallet.waitForSyncedState();
      after = balanceOf(s.shielded.balances, leg.colour);
      if (after === before.colour - leg.amount) break;
      await sleep(3000);
    }
    const result = {
      offerId,
      leg,
      to: d.keys.shieldedAddress,
      funding: {
        identifier,
        hash: tx.hash,
        block: tx.block?.height,
        blockUtc: tx.block?.timestamp ? new Date(Number(tx.block.timestamp)).toISOString() : undefined,
        status: tx.transactionResult?.status,
        feeSpecks,
        feeDust: Number(feeSpecks) / 1e15,
      },
      fundingWallet: {
        syncSeconds,
        colourBefore: before.colour,
        colourAfter: after,
        colourDelta: after - before.colour,
        dustBeforeSpecks: before.dust,
      },
      timings: { provingSeconds, submitToIndexedSeconds: submitSeconds },
      pass: tx.transactionResult?.status === 'SUCCESS' && after === before.colour - leg.amount,
    };
    writeEvidence('t2-fund', result);
    say('T.2 fund', result);
    if (!result.pass) throw new Error('T.2 FAILED: see the evidence');
  } finally {
    await opened.stop().catch(() => undefined);
    d.keys.clear();
  }
}

// ---- the take (T.3 + T.4) -------------------------------------------------------------------------

async function openTemporary(d: Derived) {
  const t0 = performance.now();
  const w = await openShieldedWallet(d.keys.shieldedSecretKeys, {
    networkId: NETWORK_ID,
    indexerUrl: NET.midnight.indexerUrl,
    indexerWsUrl: NET.midnight.indexerWsUrl,
  });
  let last = 0;
  const unsub = w.onProgress((p) => {
    if (performance.now() - last > 15_000) {
      last = performance.now();
      say('sync', { appliedIndex: p.appliedIndex, latestIndex: p.latestIndex });
    }
  });
  await w.waitSynced();
  unsub();
  return { w, syncSeconds: secondsSince(t0) };
}

async function waitFor<T>(label: string, fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label} (last: ${inspect(jsonSafe(v))})`);
    await sleep(3000);
  }
}

async function cmdTake(offerId: string): Promise<void> {
  const state = loadState();
  if (state.takeTx) throw new Error(`this gate already took an offer (${state.takeTx}); one offer per gate`);
  const d = await deriveTemporaryWallet();
  const { w, syncSeconds } = await openTemporary(d);
  say('temporary wallet synced', { seconds: syncSeconds });
  try {
    const before = await w.balances();
    const offer = await fetchOffer(offerId);
    const makerTx = decodeMakerTransaction(offer.offerBech32);
    if (offerIdOf(makerTx.serialize()) !== offerId) throw new Error('the kernel served bytes for another offer');
    const terms = takeTerms(makerTx);
    say('terms', { terms, holds: before });

    const statusBefore = await offerStatus(offerId);
    if (statusBefore !== 'live') {
      writeEvidence('t3-take-offer-gone', { offerId, status: statusBefore });
      throw new Error(`offer ${offerId} is ${statusBefore} before the take`);
    }
    const build = await buildTake({
      makerTx,
      wallet: w.wallet,
      secretKeys: d.keys.shieldedSecretKeys,
      prover: serverProvingService(PROOF),
      balances: before,
    });
    say('settlement built', {
      balancingMs: Math.round(build.balancingMs),
      provingMs: Math.round(build.provingMs),
      chars: build.settlementHex.length,
    });
    const statusAtSubmit = await offerStatus(offerId);
    if (statusAtSubmit !== 'live') {
      await w.wallet.revertTransaction(build.settlement).catch(() => undefined);
      writeEvidence('t3-take-offer-gone', { offerId, status: statusAtSubmit, stage: 'after proving' });
      throw new Error(`offer ${offerId} is ${statusAtSubmit} at submit time`);
    }
    const t0 = performance.now();
    const b = await submitToBatcher({
      batcherUrl: BATCHER,
      txHex: build.settlementHex,
      address: d.keys.unshieldedAddress,
      target: NET.zswap.batcherTarget,
    });
    const batcherSeconds = secondsSince(t0);
    say('batcher answered', {
      ok: b.ok,
      httpStatus: b.httpStatus,
      tx: b.transactionHash,
      error: b.error,
      seconds: batcherSeconds,
    });
    if (!b.ok || !b.transactionHash) {
      const lostRace = /239|NullifierAlreadyPresent/i.test(`${b.error ?? ''} ${JSON.stringify(b.body)}`);
      writeEvidence('t3-take-refused', {
        offerId,
        lostRace,
        httpStatus: b.httpStatus,
        error: b.error,
        body: b.body,
        batcherSeconds,
      });
      throw new Error(`${lostRace ? 'LOST RACE' : 'REFUSED'}: ${b.error ?? b.httpStatus}`);
    }
    state.takeTx = b.transactionHash;
    saveState(state);

    const tx = await txBy({ hash: b.transactionHash.replace(/^0x/, '') });
    const makerIds = makerTx.identifiers().map((i) => String(i).toLowerCase());
    const onChainIds = new Set<string>((tx.identifiers ?? []).map((i: string) => i.toLowerCase()));
    const consumedByOurTx = makerIds.every((i) => onChainIds.has(i));
    const status = await waitFor(
      'the offer consumed',
      () => offerStatus(offerId),
      (s) => s === 'consumed',
      300_000,
    );
    const give = terms.give[0]!;
    const recv = terms.receive[0]!;
    const after = await waitFor(
      "the maker's leg in the temporary wallet",
      () => w.balances(),
      (bal) => (bal[recv.colour] ?? 0n) === (before[recv.colour] ?? 0n) + recv.amount,
      300_000,
    );
    const result = {
      offerId,
      terms,
      take: {
        batcherTransactionHash: b.transactionHash,
        indexedHash: tx.hash,
        block: tx.block?.height,
        blockUtc: tx.block?.timestamp ? new Date(Number(tx.block.timestamp)).toISOString() : undefined,
        status: tx.transactionResult?.status,
        feeSpecksPaidByBatcher: tx.fee,
        makerIdentifiers: makerIds,
        consumedByOurTx,
      },
      kernelStatus: status,
      temporaryWallet: {
        ...publicKeys(d.keys),
        before,
        after,
        received: (after[recv.colour] ?? 0n) - (before[recv.colour] ?? 0n),
        spent: (before[give.colour] ?? 0n) - (after[give.colour] ?? 0n),
        dustSpendsInOurSettlement: build.dustSpends,
        makerTxHasIntents: makerTx.intents !== undefined && makerTx.intents.size > 0,
      },
      timings: {
        syncSeconds,
        balancingMs: Math.round(build.balancingMs),
        provingMs: Math.round(build.provingMs),
        batcherSeconds,
      },
      settlementChars: build.settlementHex.length,
      pass:
        consumedByOurTx &&
        status === 'consumed' &&
        tx.transactionResult?.status === 'SUCCESS' &&
        (after[recv.colour] ?? 0n) - (before[recv.colour] ?? 0n) === recv.amount &&
        (before[give.colour] ?? 0n) - (after[give.colour] ?? 0n) === give.amount &&
        build.dustSpends === 0,
    };
    writeEvidence('t3-take', result);
    say('T.3 take', result);
    if (!result.pass) throw new Error('T.3 FAILED: see the evidence');
  } catch (e) {
    say('take failed', { error: errorChain(e) });
    throw e;
  } finally {
    await w.stop().catch(() => undefined);
    d.keys.clear();
  }
}

async function cmdMeasureSync(): Promise<void> {
  const seed = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  const keys = temporaryWalletKeys(seed, NETWORK_ID);
  const t0 = performance.now();
  const w = await openShieldedWallet(keys.shieldedSecretKeys, {
    networkId: NETWORK_ID,
    indexerUrl: NET.midnight.indexerUrl,
    indexerWsUrl: NET.midnight.indexerWsUrl,
  });
  const s = await w.waitSynced();
  const seconds = secondsSince(t0);
  const result = {
    runtime: `bun ${process.versions.bun ?? '?'}`,
    freshSeedSyncSeconds: seconds,
    appliedIndex: Number(s.progress.appliedIndex),
    latestIndex: Number(s.progress.highestRelevantWalletIndex),
  };
  writeEvidence('t4-fresh-sync-bun', result);
  say('T.4 fresh-seed sync', result);
  await w.stop();
  keys.clear();
}

async function cmdStatus(): Promise<void> {
  const d = await deriveTemporaryWallet();
  const { w, syncSeconds } = await openTemporary(d);
  say('temporary wallet', { ...publicKeys(d.keys), syncSeconds, balances: await w.balances(), state: loadState() });
  await w.stop();
  d.keys.clear();
}

// ---- main -----------------------------------------------------------------------------------------

const [cmd, arg] = process.argv.slice(2);
const needOffer = (): string => {
  if (!arg || !/^[0-9a-f]{64}$/.test(arg)) throw new Error('give the full 64-hex offer id');
  return arg;
};
try {
  switch (cmd) {
    case 'derive':
      await cmdDerive();
      break;
    case 'fund':
      await cmdFund(needOffer());
      break;
    case 'take':
      await cmdTake(needOffer());
      break;
    case 'measure-sync':
      await cmdMeasureSync();
      break;
    case 'status':
      await cmdStatus();
      break;
    default:
      throw new Error('usage: gate.ts derive | fund <offerId> | take <offerId> | measure-sync | status');
  }
  process.exit(0);
} catch (e) {
  say('FAILED', { error: errorChain(e) });
  process.exit(/LOST RACE/.test(errorChain(e)) ? 3 : 1);
}

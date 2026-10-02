// G-BRIDGE (plan 00048, P1): the ERC20 vault's round trip for a swap's TEMPORARY Midnight wallet,
// with the sponsor paying every DUST fee. Live on Midnight stagenet and Sepolia.
//
// One command per step, each its own process (run it through run-gate.sh, which holds the shared
// funding-wallet lock for the sponsor steps, starts the proof server, and mounts the secrets
// read-only). State between steps lives OUTSIDE the repository in $GATE_STATE_DIR (public values
// only: the salt, public keys, addresses, request ids, transaction hashes); evidence goes to
// $GATE_EVIDENCE_DIR.
//
//   preflight          read-only: stagenet version, the vault's verifier keys vs ours, MPC root, balances
//   derive             B.1  a new temporary wallet from "start swap" (signed twice); its deposit address
//                           computed offline and checked against the vault's own compiled derivation
//   fund               B.2.1 Sepolia: exactly 1 token + the tightly sized sweep ETH to the deposit address
//   deposit-start      B.2.2 the sponsor submits startDeposit (recipient = the temporary coin public key)
//   relay --kind deposit|withdraw   the MPC signature -> broadcast -> finality -> attestation (no wallet)
//   deposit-complete   B.2.4 the sponsor submits completeDeposit, sealing the coin to the temporary wallet
//   temp-check         B.2.5 the temporary wallet (its own sync) sees the minted coin
//   withdraw-build     B.3.1 the temporary wallet builds startWithdraw, balances ONLY its shielded side, proves
//   withdraw-submit    B.3.2 the sponsor adds DUST (dust-only balancing + merge) and submits
//   withdraw-complete  B.3.4 the sponsor submits completeWithdraw
//   status             read-only summary
//
// SECRETS: the sponsor seed (STAGENET_WALLET_FILE) and the Sepolia key (SEPOLIA_KEY_FILE) are read
// in this process only. The temporary wallet's seed is re-derived from a fresh signature in each
// step that needs it and never leaves the process. Nothing secret is printed or written.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { ethers } from 'ethers';
import * as Rx from 'rxjs';

import {
  DEFAULT_EVM_GAS,
  STAGENET,
  SWAP_KEY_DERIVATION_VERSION,
  depositAddressFor,
  depositPathOf,
  depositPreflight,
  newSwapSalt,
  stagenetRegistry,
  startSwapTypedData,
  walletRecipient,
} from '@evm-midnight-transparent/core';
import { type TemporaryWalletKeys } from '@evm-midnight-transparent/wallet';
import vaultRecord from '../../../packages/core/src/tokens/deployments/stagenet-vault.json';
import { parseSponsorSeed } from '../../../sponsor/src/config.js';
import { openFacadeWallet, type OpenedWallet } from '../../../sponsor/src/sponsor/facade.js';
import {
  addDustAndSubmit,
  artefactFingerprints,
  loadVault,
  openRequests,
  proofProviderFor,
  publicDataProviderFor,
  requestOfCall,
  settle,
  sponsorProviders,
  startDeposit,
  verifyVaultKeys,
  type VaultEndpoints,
  type VaultRuntime,
} from '../../../sponsor/src/bridge/vault.js';
import { relayRequest, type RelayProgress, type RelayResult } from '../../../sponsor/src/bridge/vendor/relayer.js';
import {
  bytesToHex,
  deriveEvmAddress,
  deriveMidnightResponseKey,
  getMpcRootPublicKey,
  getSignetContractAddress,
  normaliseSecp256k1PublicKey,
} from '../../../sponsor/src/bridge/vendor/signet-sdk.js';
import { buildStartWithdraw, deriveTemp, openTemp } from './temp-wallet.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;
type Json = Record<string, unknown>;

// ── Constants ─────────────────────────────────────────────────────────────────

const NETWORK_ID = 'stagenet';
const EXPECTED_NODE_VERSION = process.env.EXPECTED_NODE_VERSION ?? '2.0.0-d9729c13';
const SEPOLIA_CHAIN_ID = 11155111n;
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
/** The test EVM user (`.sepolia`): pays the deposit, receives the withdrawal. */
const USER = '0x484738A67858305Edfc139B194Ed430Fe4D8e56b';
const VAULT = vaultRecord.vaultContractAddress;
const VAULT_EVM = vaultRecord.vaultEvmAddress;
const SINGLETON = vaultRecord.signetSingleton;
const MPC_ROOT = normaliseSecp256k1PublicKey(vaultRecord.mpcRootPublicKey);

/** Plan Q8 A caps per run. */
const CAP = { dustSpecks: 100n * 10n ** 15n, sepoliaWei: ethers.parseEther('0.02'), tokens: 10n };
/** The vault's EVM account pays each withdrawal's gas; below this the plan says STOP and ask. */
const VAULT_EVM_MIN_WEI = ethers.parseEther('0.001');
/** Sweep sizing (spec Q5 A), recorded with the run: see `sweepGas`. */
const SWEEP_GAS_LIMIT = BigInt(process.env.SWEEP_GAS_LIMIT ?? '65000');
const SWEEP_TIP_WEI = BigInt(process.env.SWEEP_TIP_WEI ?? '500000000'); // 0.5 gwei
const GWEI_TENTH = 100_000_000n;

const STATE_DIR =
  process.env.GATE_STATE_DIR ?? path.join(process.env.HOME ?? '/root', '.config', 'aa-00048', 'gate-bridge');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const WITHDRAW_TX_FILE = path.join(STATE_DIR, 'withdraw-start.tx');
const EVIDENCE_DIR = process.env.GATE_EVIDENCE_DIR ?? '';
const MANAGED_DIR = process.env.VAULT_MANAGED_DIR ?? '';
const PROOF_SERVER_URL = process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300';
const FEE_BLOCKS_MARGIN = Number(process.env.FEE_BLOCKS_MARGIN ?? '5');

const ENDPOINTS: VaultEndpoints = {
  networkId: NETWORK_ID,
  indexerUrl: STAGENET.midnight.indexerUrl,
  indexerWsUrl: STAGENET.midnight.indexerWsUrl,
  proofServerUrl: PROOF_SERVER_URL,
};

// ── Small helpers ─────────────────────────────────────────────────────────────

const log = (line: string) => console.log(line);
const nowUtc = () => new Date().toISOString();
const secs = (ms: number) => Math.round(ms / 100) / 10;
const strip0x = (h: string) => h.replace(/^0x/i, '').toLowerCase();
const dustText = (specks: bigint | null) => (specks === null ? 'unknown' : `${Number(specks) / 1e15}`);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function toJson(value: unknown): string {
  return `${JSON.stringify(
    value,
    (_k, v: unknown) => {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Uint8Array) return bytesToHex(v);
      return v;
    },
    2,
  )}\n`;
}

interface State {
  network: string;
  createdUtc: string;
  token?: { symbol: string; erc20: string; decimals: number; colour: string; midnightName: string };
  amount?: string;
  salt?: string;
  typedData?: Json;
  temp?: { coinPublicKey: string; encryptionPublicKey: string; deterministic: boolean };
  depositAddress?: Json;
  sweep?: Json;
  fund?: Json;
  deposit?: Json & { requestId?: string; relay?: Json[]; relayResult?: Json; startTx?: Json; completeTx?: Json };
  tempCheck?: Json;
  finalCheck?: Json;
  withdraw?: Json & { requestId?: string; relay?: Json[]; relayResult?: Json; submitTx?: Json; completeTx?: Json };
  dust?: Record<string, string>;
  history?: Json[];
}

function ensureDir(dir: string, mode = 0o700) {
  mkdirSync(dir, { recursive: true, mode });
  chmodSync(dir, mode);
}

function loadState(): State {
  return existsSync(STATE_FILE)
    ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State)
    : { network: NETWORK_ID, createdUtc: nowUtc() };
}

function saveState(s: State) {
  ensureDir(STATE_DIR);
  writeFileSync(STATE_FILE, toJson(s), { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
}

function saveEvidence(name: string, value: unknown) {
  if (!EVIDENCE_DIR) throw new Error('GATE_EVIDENCE_DIR is not set');
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(path.join(EVIDENCE_DIR, name), toJson(value));
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} is missing from the state: run the earlier step first`);
  return v;
}

function sepolia(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(SEPOLIA_RPC_URL, undefined, { staticNetwork: true });
}

/** The test user's Sepolia key, read from its file in THIS process only. */
async function sepoliaUser(provider: ethers.JsonRpcProvider): Promise<ethers.Wallet> {
  const file = process.env.SEPOLIA_KEY_FILE ?? '/secrets/sepolia';
  const line = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .find((l) => /^\s*SK\s*=/.test(l));
  if (line === undefined) throw new Error('no SK= line in the Sepolia key file');
  const hex = strip0x(
    line
      .replace(/^\s*SK\s*=\s*/, '')
      .trim()
      .replace(/^['"]|['"]$/g, ''),
  );
  const wallet = new ethers.Wallet(`0x${hex}`, provider);
  if (wallet.address.toLowerCase() !== USER.toLowerCase())
    throw new Error('the Sepolia key file is not the expected user');
  const { chainId } = await provider.getNetwork();
  if (chainId !== SEPOLIA_CHAIN_ID) throw new Error(`the EVM RPC is chain ${chainId}, not Sepolia`);
  return wallet;
}

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];

async function erc20Balance(p: ethers.Provider, erc20: string, holder: string): Promise<bigint> {
  return (await new ethers.Contract(erc20, ERC20_ABI, p).getFunction('balanceOf')(holder)) as bigint;
}

async function nodeRpc(method: string): Promise<unknown> {
  const res = await fetch(STAGENET.midnight.nodeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`node ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function setNetwork() {
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId(NETWORK_ID as never);
}

function managedDir(): string {
  if (!MANAGED_DIR) throw new Error('VAULT_MANAGED_DIR is not set');
  return MANAGED_DIR;
}

function tokenFromArgs() {
  const symbol = arg('token') ?? 'stkA';
  const t = stagenetRegistry().bySymbol(symbol);
  if (!t) throw new Error(`unknown token ${symbol}`);
  if (t.vault !== VAULT) throw new Error(`${symbol} is not bridged by the vault ${VAULT}`);
  return {
    symbol: t.symbol,
    erc20: t.sepoliaAddress,
    decimals: t.decimals,
    colour: t.midnightColour,
    midnightName: t.midnightName,
  };
}

/** The sum of the DUST fees a transaction declares (its DUST spends' vFee), in specks: what it consumes. */
function dustFeeSpecks(tx: Any): bigint | null {
  try {
    let total = 0n;
    for (const intent of (tx.intents as Map<number, Any> | undefined)?.values() ?? []) {
      for (const spend of intent?.dustActions?.spends ?? []) total += BigInt(spend.vFee);
    }
    return total;
  } catch {
    return null;
  }
}

function addDust(s: State, leg: string, specks: bigint | null) {
  s.dust = { ...(s.dust ?? {}), [leg]: dustText(specks) };
  const total = Object.values(s.dust)
    .map((v) => (v === 'unknown' ? 0 : Number(v)))
    .reduce((a, b) => a + b, 0);
  if (BigInt(Math.ceil(total * 1e15)) > CAP.dustSpecks)
    throw new Error(`DUST spent this run (${total}) is over the cap`);
}

async function liveLedgerParameters(): Promise<Any> {
  const ledger = await import('@midnightntwrk/ledger-v9');
  const res = await fetch(STAGENET.midnight.indexerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ block { height ledgerParameters } }' }),
  });
  const body = (await res.json()) as { data?: { block?: { ledgerParameters?: string } } };
  const hex = body.data?.block?.ledgerParameters;
  if (!hex) throw new Error('no ledgerParameters from the indexer');
  return ledger.LedgerParameters.deserialize(Buffer.from(hex, 'hex'));
}

// ── The sponsor ───────────────────────────────────────────────────────────────

interface Sponsor {
  opened: OpenedWallet;
  cpk: string;
  epk: string;
  dust(): Promise<bigint>;
}

async function openSponsor(): Promise<Sponsor> {
  const file = process.env.STAGENET_WALLET_FILE ?? '/secrets/stagenet';
  const seedHex = parseSponsorSeed(readFileSync(file, 'utf8'));
  const t0 = Date.now();
  const opened = await openFacadeWallet(
    seedHex,
    { ...ENDPOINTS, nodeWsUrl: STAGENET.midnight.nodeWsUrl },
    { feeBlocksMargin: FEE_BLOCKS_MARGIN },
  );
  const wallet = (opened.handle as Any).wallet;
  const synced: Any = await Rx.firstValueFrom(
    (wallet.state() as Rx.Observable<Any>).pipe(
      Rx.throttleTime(5_000),
      Rx.filter((st: Any) => st.isSynced === true),
    ),
  );
  log(`      sponsor wallet synced in ${secs(Date.now() - t0)} s`);
  const dust = async () => {
    const st: Any = await Rx.firstValueFrom(
      (wallet.state() as Rx.Observable<Any>).pipe(Rx.filter((x: Any) => x.isSynced)),
    );
    return BigInt(st.dust.balance(new Date()));
  };
  return {
    opened,
    cpk: synced.shielded.coinPublicKey.toHexString(),
    epk: synced.shielded.encryptionPublicKey.toHexString(),
    dust,
  };
}

/** Wraps the sponsor's midnight-js providers so the finalized transaction each call submits is
 *  kept: its DUST spends are the leg's real cost. */
async function sponsorProvidersRecording(rt: VaultRuntime, sp: Sponsor) {
  const providers: Any = await sponsorProviders(rt, sp.opened, ENDPOINTS, sp.cpk, sp.epk);
  const seen: Any[] = [];
  const balance = providers.walletProvider.balanceTx.bind(providers.walletProvider);
  providers.walletProvider.balanceTx = async (tx: Any, ttl?: Date) => {
    const out = await balance(tx, ttl);
    seen.push(out);
    return out;
  };
  providers.midnightProvider = providers.walletProvider;
  return { providers, lastTx: () => seen.at(-1) };
}

// ── The temporary wallet ──────────────────────────────────────────────────────

async function tempKeysFromSignature(
  s: State,
): Promise<{ keys: TemporaryWalletKeys; deterministic: boolean; prompts: number }> {
  const provider = sepolia();
  try {
    const user = await sepoliaUser(provider);
    const d = await deriveTemp(user, { network: NETWORK_ID, vault: VAULT, salt: need(s.salt, 'salt') });
    if (!d.deterministic) throw new Error('the two start-swap signatures differ: the signer is not deterministic');
    if (s.temp && d.keys.coinPublicKey !== s.temp.coinPublicKey) {
      d.keys.clear();
      throw new Error('the re-derived temporary wallet is not the one recorded');
    }
    return { keys: d.keys, deterministic: d.deterministic, prompts: d.prompts };
  } finally {
    provider.destroy();
  }
}

// ── preflight ─────────────────────────────────────────────────────────────────

async function cmdPreflight() {
  await setNetwork();
  const version = String(await nodeRpc('system_version'));
  if (version !== EXPECTED_NODE_VERSION)
    throw new Error(`stagenet runs ${version}, expected ${EXPECTED_NODE_VERSION}: STOP`);
  const rt = await loadVault(managedDir());
  const pdp = await publicDataProviderFor(ENDPOINTS);
  const keys = await verifyVaultKeys(rt, pdp, VAULT, SINGLETON);
  const root = normaliseSecp256k1PublicKey(getMpcRootPublicKey(NETWORK_ID as never));
  const vaultEvm = deriveEvmAddress(root, VAULT, bytesToHex(rt.pureCircuits.vaultPath()));
  const provider = sepolia();
  try {
    const t = tokenFromArgs();
    const out = {
      at: nowUtc(),
      nodeVersion: version,
      vault: VAULT,
      singleton: SINGLETON,
      singletonMatchesSdk: strip0x(getSignetContractAddress(NETWORK_ID as never)) === SINGLETON,
      mpcRootMatchesRecord: root === MPC_ROOT,
      vaultEvmDerived: vaultEvm,
      vaultEvmMatchesRecord: vaultEvm.toLowerCase() === VAULT_EVM.toLowerCase(),
      verifierKeys: keys,
      artefacts: artefactFingerprints(rt.managedDir),
      sepolia: {
        block: await provider.getBlockNumber(),
        vaultEvm: {
          address: VAULT_EVM,
          eth: ethers.formatEther(await provider.getBalance(VAULT_EVM)),
          pendingNonce: await provider.getTransactionCount(VAULT_EVM, 'pending'),
          [t.symbol]: (await erc20Balance(provider, t.erc20, VAULT_EVM)).toString(),
        },
        user: {
          address: USER,
          eth: ethers.formatEther(await provider.getBalance(USER)),
          [t.symbol]: (await erc20Balance(provider, t.erc20, USER)).toString(),
        },
      },
    };
    saveEvidence('preflight.json', out);
    log(toJson(out));
    if (!keys.ok || !out.mpcRootMatchesRecord || !out.vaultEvmMatchesRecord || !out.singletonMatchesSdk) {
      throw new Error('preflight FAILED: see preflight.json');
    }
  } finally {
    provider.destroy();
  }
}

// ── B.1 derive ────────────────────────────────────────────────────────────────

async function cmdDerive() {
  await setNetwork();
  const s = loadState();
  if (s.temp) throw new Error('this state already has a temporary wallet; start a new state directory for a new run');
  const t = tokenFromArgs();
  s.token = t;
  s.amount = (10n ** BigInt(t.decimals)).toString(); // exactly 1 token
  s.salt = newSwapSalt();
  s.typedData = {
    ...startSwapTypedData({ network: NETWORK_ID, vault: VAULT, salt: s.salt }),
    derivationVersion: SWAP_KEY_DERIVATION_VERSION,
  };
  const t0 = Date.now();
  const { keys, deterministic, prompts } = await tempKeysFromSignature(s);
  const deriveMs = Date.now() - t0;

  // The deposit address, three ways: our TypeScript twin, the vault's compiled circuit, and the
  // 00037 worked example (a fixed vector: coin key c6a35196… -> 0x5f89…3714).
  const rt = await loadVault(managedDir());
  const twin = depositAddressFor(MPC_ROOT, VAULT, keys.coinPublicKey);
  const twinPath = bytesToHex(depositPathOf(walletRecipient(keys.coinPublicKey)));
  const compiledPath = bytesToHex(rt.pureCircuits.depositPath(walletRecipient(keys.coinPublicKey)));
  const helper = deriveEvmAddress(MPC_ROOT, VAULT, compiledPath);
  const vectorCpk = 'c6a35196428ac58a956e93e0c3c7c7df254e428a827291e9111fde7037cd34a1';
  const vector = {
    coinPublicKey: vectorCpk,
    expected: '0x5f89AB8632a7Cf386a32a1634D4F23312c0F3714',
    twin: depositAddressFor(MPC_ROOT, VAULT, vectorCpk),
    compiled: deriveEvmAddress(MPC_ROOT, VAULT, bytesToHex(rt.pureCircuits.depositPath(walletRecipient(vectorCpk)))),
  };
  const ok =
    twin === helper &&
    twinPath === compiledPath &&
    vector.twin === vector.expected &&
    vector.compiled === vector.expected;
  s.temp = {
    coinPublicKey: keys.coinPublicKey,
    encryptionPublicKey: keys.encryptionPublicKey,
    deterministic,
  };
  s.depositAddress = {
    address: twin,
    depositPath: twinPath,
    twin,
    vaultHelper: helper,
    compiledDepositPath: compiledPath,
    vector,
    match: ok,
    derivation:
      "deriveEvmAddress(mpcRoot, vault, hex(depositPath(left(tempCoinPk)))); depositPath via compact-runtime persistentHash (twin) and via the vault's compiled pureCircuits.depositPath (helper)",
  };
  saveState(s);
  const out = {
    step: 'B.1',
    at: nowUtc(),
    token: t,
    amount: s.amount,
    typedData: s.typedData,
    signedTwiceEqual: deterministic,
    signaturePrompts: prompts,
    shieldedAddress: keys.shieldedAddress,
    deriveMs,
    temp: s.temp,
    depositAddress: s.depositAddress,
  };
  saveEvidence('b1-derive.json', out);
  keys.clear();
  log(toJson(out));
  if (!ok) throw new Error('B.1 FAILED: the deposit address derivations disagree');
}

// ── B.2.1 fund ────────────────────────────────────────────────────────────────

/** The sweep's EIP-1559 fields, sized tightly (spec Q5 A):
 *    maxPriorityFeePerGas = tip (0.5 gwei)
 *    maxFeePerGas         = ceil_0.1gwei(2 × latest baseFee + tip)
 *    gasLimit             = 65,000 (a stk sweep uses 46,777; USDC's about 57k)
 *    sweep ETH            = gasLimit × maxFeePerGas  (exactly what the node requires the sender to hold) */
async function sweepGas(provider: ethers.Provider) {
  const block = await provider.getBlock('latest');
  const baseFee = block?.baseFeePerGas ?? 0n;
  const raw = 2n * baseFee + SWEEP_TIP_WEI;
  const maxFeePerGas = ((raw + GWEI_TENTH - 1n) / GWEI_TENTH) * GWEI_TENTH;
  return {
    gasLimit: SWEEP_GAS_LIMIT,
    maxFeePerGas,
    maxPriorityFeePerGas: SWEEP_TIP_WEI,
    keyVersion: 1n,
    baseFeeAtSizing: baseFee,
    blockAtSizing: block?.number ?? null,
    sweepWei: SWEEP_GAS_LIMIT * maxFeePerGas,
    formula:
      'sweepWei = gasLimit x maxFeePerGas; maxFeePerGas = ceil_0.1gwei(2 x baseFee + tip); tip 0.5 gwei; gasLimit 65,000',
  };
}

async function cmdFund() {
  const s = loadState();
  const t = need(s.token, 'token');
  const dep = String(need(s.depositAddress, 'depositAddress').address);
  const amount = BigInt(need(s.amount, 'amount'));
  if (s.fund) throw new Error('already funded; not sending twice');
  if (amount > CAP.tokens * 10n ** BigInt(t.decimals)) throw new Error('over the token cap');
  const provider = sepolia();
  try {
    const user = await sepoliaUser(provider);
    const held = await erc20Balance(provider, t.erc20, dep);
    const heldEth = await provider.getBalance(dep);
    if (held !== 0n || heldEth !== 0n)
      throw new Error(`the deposit address is not fresh (${held} token, ${heldEth} wei)`);
    const gas = await sweepGas(provider);
    if (gas.sweepWei > CAP.sepoliaWei / 4n)
      throw new Error(`the sweep ETH ${ethers.formatEther(gas.sweepWei)} is implausibly high: STOP`);
    s.sweep = { ...gas };
    saveState(s);
    const t0 = Date.now();
    const erc20 = new ethers.Contract(t.erc20, ERC20_ABI, user);
    const tx1 = await erc20.getFunction('transfer')(dep, amount);
    log(`      ${t.symbol} transfer sent ${String(tx1.hash)}`);
    const rc1 = await tx1.wait(1);
    const tx2 = await user.sendTransaction({ to: dep, value: gas.sweepWei });
    log(`      sweep ETH sent ${tx2.hash}`);
    const rc2 = await tx2.wait(1);
    const cost = (rc: Any) => BigInt(rc.gasUsed) * BigInt(rc.gasPrice ?? rc.effectiveGasPrice);
    s.fund = {
      atUtc: nowUtc(),
      seconds: secs(Date.now() - t0),
      erc20Tx: {
        hash: rc1?.hash,
        block: rc1?.blockNumber,
        status: rc1?.status,
        amount: amount.toString(),
        gasUsed: rc1?.gasUsed,
        feeWei: cost(rc1),
      },
      ethTx: {
        hash: rc2?.hash,
        block: rc2?.blockNumber,
        status: rc2?.status,
        wei: gas.sweepWei,
        gasUsed: rc2?.gasUsed,
        feeWei: cost(rc2),
      },
      depositAddressAfter: {
        token: (await erc20Balance(provider, t.erc20, dep)).toString(),
        wei: (await provider.getBalance(dep)).toString(),
      },
    };
    saveState(s);
    saveEvidence('b2-1-fund.json', { step: 'B.2.1', depositAddress: dep, sweep: s.sweep, fund: s.fund });
    log(toJson({ sweep: s.sweep, fund: s.fund }));
  } finally {
    provider.destroy();
  }
}

// ── B.2.2 deposit-start ───────────────────────────────────────────────────────

async function cmdDepositStart() {
  await setNetwork();
  const s = loadState();
  const t = need(s.token, 'token');
  const temp = need(s.temp, 'temp');
  const dep = String(need(s.depositAddress, 'depositAddress').address);
  const sw = need(s.sweep, 'sweep') as Any;
  const amount = BigInt(need(s.amount, 'amount'));
  if (s.deposit?.requestId) throw new Error(`deposit request ${s.deposit.requestId} already exists: relay/complete it`);
  const gas = {
    gasLimit: BigInt(sw.gasLimit),
    maxFeePerGas: BigInt(sw.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(sw.maxPriorityFeePerGas),
    keyVersion: BigInt(sw.keyVersion),
  };
  const provider = sepolia();
  let evmNonce: bigint;
  try {
    const pre = depositPreflight({
      erc20Balance: await erc20Balance(provider, t.erc20, dep),
      amount,
      ethBalance: await provider.getBalance(dep),
      gasLimit: gas.gasLimit,
      maxFeePerGas: gas.maxFeePerGas,
      decimals: t.decimals,
    });
    if (!pre.ok) throw new Error(`deposit preflight refused: ${pre.problems.join('; ')}`);
    evmNonce = BigInt(await provider.getTransactionCount(dep, 'pending'));
  } finally {
    provider.destroy();
  }
  const rt = await loadVault(managedDir());
  const sp = await openSponsor();
  try {
    const { providers, lastTx } = await sponsorProvidersRecording(rt, sp);
    const dustBefore = await sp.dust();
    const t0 = Date.now();
    const out = await startDeposit(providers, rt, VAULT, {
      evmNonce,
      gas,
      erc20: t.erc20,
      amount,
      recipientCoinPublicKeyHex: temp.coinPublicKey,
    });
    const fee = dustFeeSpecks(lastTx());
    const onChain = await openRequests(
      rt,
      (await providers.publicDataProvider.queryContractState(VAULT)).data,
      'deposit',
    );
    s.deposit = {
      evmNonce: evmNonce.toString(),
      gas: { ...gas },
      requestId: out.requestId,
      requestNonce: out.requestNonce.toString(),
      requestOpenOnChain: onChain.has(out.requestId),
      startTx: {
        txId: out.txId,
        txHash: out.txHash,
        blockHeight: out.blockHeight,
        status: out.status,
        seconds: secs(Date.now() - t0),
        atUtc: nowUtc(),
        dustFee: dustText(fee),
        sponsorDustBefore: dustText(dustBefore),
        sponsorDustAfter: dustText(await sp.dust()),
      },
    };
    addDust(s, 'startDeposit', fee);
    saveState(s);
    saveEvidence('b2-2-deposit-start.json', { step: 'B.2.2', deposit: s.deposit });
    log(toJson(s.deposit));
  } finally {
    await sp.opened.stop();
  }
}

// ── relay ─────────────────────────────────────────────────────────────────────

async function runRelay(s: State, kind: 'deposit' | 'withdraw', persist: () => void): Promise<RelayResult> {
  const rec = need(kind === 'deposit' ? s.deposit : s.withdraw, kind);
  const requestId = need(rec.requestId, `${kind}.requestId`);
  const rt = await loadVault(managedDir());
  const pdp = await publicDataProviderFor(ENDPOINTS);
  const expectedSigner = kind === 'deposit' ? String(need(s.depositAddress, 'depositAddress').address) : VAULT_EVM;
  return relayRequest({
    publicDataProvider: pdp,
    indexerUrl: ENDPOINTS.indexerUrl,
    requesterContractAddress: VAULT,
    requesterRequestsPath: kind === 'deposit' ? [0] : [2],
    signetContractAddress: SINGLETON,
    requestId,
    expectedSigner,
    mpcResponseKey: deriveMidnightResponseKey(MPC_ROOT, VAULT) as never,
    responseSchema: rt.pureCircuits.vaultResponseSchema(),
    evmRpcUrl: SEPOLIA_RPC_URL,
    outputCache: { networkId: NETWORK_ID, cacheUrl: vaultRecord.mpcOutputCacheUrl },
    intervalMs: 15_000,
    onProgress: (p: RelayProgress) => {
      rec.relay = [...(rec.relay ?? []), { ...p, atUtc: nowUtc() }];
      persist();
    },
    log,
  });
}

function relaySummary(r: RelayResult): Json {
  return {
    kind: r.kind,
    outputOrigin: r.outputOrigin,
    serializedOutput: bytesToHex(r.serializedOutput),
    evmTxHash: r.evmTxHash,
    evmBlock: r.evmBlock,
    evmStatus: r.evmStatus,
    signedTxHash: r.signedTxHash,
    signedTxSender: r.signedTxSender,
    signedTxNonce: r.signedTxNonce,
    signatureAfterS: Math.round(r.signatureAfterMs / 1000),
    attestationAfterS: Math.round(r.attestationAfterMs / 1000),
    finalizedBlockSeen: r.finalizedBlockSeen,
  };
}

async function cmdRelay() {
  await setNetwork();
  const kind = arg('kind') === 'withdraw' ? 'withdraw' : 'deposit';
  const s = loadState();
  const evidence = kind === 'deposit' ? 'b2-3-relay-deposit.json' : 'b3-3-relay-withdraw.json';
  const rec = need(kind === 'deposit' ? s.deposit : s.withdraw, kind);
  const persist = () => {
    saveState(s);
    saveEvidence(evidence, {
      step: kind === 'deposit' ? 'B.2.3' : 'B.3.3',
      requestId: rec.requestId,
      relay: rec.relay,
      relayResult: rec.relayResult,
    });
  };
  const t0 = Date.now();
  const r = await runRelay(s, kind, persist);
  rec.relayResult = { ...relaySummary(r), loopSeconds: secs(Date.now() - t0), atUtc: nowUtc() };
  if (kind === 'deposit') {
    const provider = sepolia();
    try {
      const rc = r.evmTxHash ? await provider.getTransactionReceipt(r.evmTxHash) : null;
      const dep = String(need(s.depositAddress, 'depositAddress').address);
      const sweepEth = BigInt(String((s.sweep as Any)?.sweepWei ?? '0'));
      const strandedWei = await provider.getBalance(dep);
      rec.sweepReceipt = rc
        ? {
            gasUsed: rc.gasUsed,
            effectiveGasPrice: rc.gasPrice,
            feeWei: rc.gasUsed * rc.gasPrice,
            sweepEthSent: sweepEth,
            strandedWei,
          }
        : null;
    } finally {
      provider.destroy();
    }
  } else {
    const provider = sepolia();
    try {
      const t = need(s.token, 'token');
      const rc = r.evmTxHash ? await provider.getTransactionReceipt(r.evmTxHash) : null;
      const destAfter = await erc20Balance(provider, t.erc20, USER);
      rec.transferReceipt = rc
        ? { gasUsed: rc.gasUsed, effectiveGasPrice: rc.gasPrice, feeWei: rc.gasUsed * rc.gasPrice }
        : null;
      rec.destErc20AfterTransfer = destAfter.toString();
      rec.destErc20Delta = (destAfter - BigInt(String(rec.destErc20Before))).toString();
    } finally {
      provider.destroy();
    }
  }
  persist();
  log(toJson(rec.relayResult));
}

// ── B.2.4 deposit-complete ────────────────────────────────────────────────────

async function cmdDepositComplete() {
  await setNetwork();
  const s = loadState();
  const temp = need(s.temp, 'temp');
  const dep = need(s.deposit, 'deposit');
  if (dep.completeTx) throw new Error(`already completed: ${String(dep.completeTx.txId)}`);
  const persist = () => {
    saveState(s);
    saveEvidence('b2-4-deposit-complete.json', { step: 'B.2.4', deposit: s.deposit });
  };
  const relay = await runRelay(s, 'deposit', persist); // resumable: returns once attested
  if (relay.kind !== 'success')
    throw new Error(`the deposit attested ${relay.kind}: not completing (use abandonDeposit)`);
  const rt = await loadVault(managedDir());
  const sp = await openSponsor();
  try {
    const { providers, lastTx } = await sponsorProvidersRecording(rt, sp);
    const t0 = Date.now();
    const out = await settle(providers, rt, VAULT, 'completeDeposit', {
      requestId: need(dep.requestId, 'deposit.requestId'),
      event: relay.event,
      serializedOutput: relay.serializedOutput,
      recipientCoinPublicKeyHex: temp.coinPublicKey,
      recipientEncryptionPublicKeyHex: temp.encryptionPublicKey,
    });
    const fee = dustFeeSpecks(lastTx());
    dep.completeTx = {
      txId: out.txId,
      txHash: out.txHash,
      blockHeight: out.blockHeight,
      status: out.status,
      seconds: secs(Date.now() - t0),
      atUtc: nowUtc(),
      dustFee: dustText(fee),
      encryptionKeyMapping: { coinPublicKey: temp.coinPublicKey, encryptionPublicKey: temp.encryptionPublicKey },
      mintedCoin: out.minted
        ? { nonce: bytesToHex(out.minted.nonce), color: bytesToHex(out.minted.color), value: String(out.minted.value) }
        : null,
    };
    addDust(s, 'completeDeposit', fee);
    persist();
    log(toJson(dep.completeTx));
  } finally {
    await sp.opened.stop();
  }
}

// ── B.2.5 temp-check ──────────────────────────────────────────────────────────

/** `temp-check` (B.2.5): the temporary wallet's own sync holds the minted coin. `temp-check --final`
 *  (after the withdrawal): it holds nothing any more (spec SC-003: the temporary wallet ends empty). */
async function cmdTempCheck() {
  await setNetwork();
  const s = loadState();
  const t = need(s.token, 'token');
  const final = process.argv.includes('--final');
  const expected = final ? 0n : BigInt(need(s.amount, 'amount'));
  const { keys } = await tempKeysFromSignature(s);
  const temp = await openTemp(keys, ENDPOINTS, log);
  try {
    const coins = await temp.coins();
    const balance = await temp.balance(t.colour);
    const minted = (s.deposit?.completeTx as Any)?.mintedCoin;
    const check = {
      atUtc: nowUtc(),
      syncSeconds: secs(temp.syncMs),
      colour: t.colour,
      balance: balance.toString(),
      expected: expected.toString(),
      availableCoins: coins,
      mintedCoinSeen: minted ? coins.some((c) => c.nonce === strip0x(minted.nonce) && c.value === minted.value) : null,
      pass: balance === expected && (!final || coins.length === 0),
    };
    if (final) s.finalCheck = check;
    else s.tempCheck = check;
    saveState(s);
    saveEvidence(final ? 'b3-5-temp-final.json' : 'b2-5-temp-check.json', {
      step: final ? 'B.3 (after)' : 'B.2.5',
      [final ? 'finalCheck' : 'tempCheck']: check,
    });
    log(toJson(check));
    if (!check.pass) throw new Error(`temp-check FAILED: the temporary wallet holds ${balance}, expected ${expected}`);
  } finally {
    await temp.stop();
    keys.clear();
  }
}

// ── B.3.1 withdraw-build ──────────────────────────────────────────────────────

async function cmdWithdrawBuild() {
  await setNetwork();
  const s = loadState();
  const t = need(s.token, 'token');
  const amount = BigInt(need(s.amount, 'amount'));
  if (s.withdraw?.submitTx) throw new Error('the withdrawal was already submitted');
  const provider = sepolia();
  let evmNonce: bigint;
  let destBefore: bigint;
  let vaultEth: bigint;
  try {
    vaultEth = await provider.getBalance(VAULT_EVM);
    if (vaultEth < VAULT_EVM_MIN_WEI) {
      throw new Error(
        `STOP: the vault's EVM account ${VAULT_EVM} holds ${ethers.formatEther(vaultEth)} ETH (< 0.001); ask the owner before funding it`,
      );
    }
    const held = await erc20Balance(provider, t.erc20, VAULT_EVM);
    if (held < amount) throw new Error(`the vault's EVM account holds only ${held} of ${t.symbol}`);
    evmNonce = BigInt(await provider.getTransactionCount(VAULT_EVM, 'pending'));
    destBefore = await erc20Balance(provider, t.erc20, USER);
  } finally {
    provider.destroy();
  }
  const { keys } = await tempKeysFromSignature(s);
  const rt = await loadVault(managedDir());
  const pdp = await publicDataProviderFor(ENDPOINTS);
  const proofProvider = await proofProviderFor(rt, PROOF_SERVER_URL);
  const temp = await openTemp(keys, ENDPOINTS, log);
  try {
    const bal = await temp.balance(t.colour);
    if (bal < amount) throw new Error(`the temporary wallet holds ${bal} of ${t.midnightName}, less than ${amount}`);
    const gas = { ...DEFAULT_EVM_GAS };
    const built = await buildStartWithdraw(
      rt,
      temp,
      keys,
      { publicDataProvider: pdp, proofProvider },
      {
        vault: VAULT,
        evmNonce,
        gas,
        erc20: ethers.getBytes(t.erc20),
        amount,
        dest: ethers.getBytes(USER),
        colour: ethers.getBytes(`0x${t.colour}`),
        coinNonce: new Uint8Array(randomBytes(32)),
        refundRecipient: walletRecipient(keys.coinPublicKey),
      },
      log,
    );
    const req = await requestOfCall(rt, built.nextContractState, 'withdraw', bytesToHex(rt.pureCircuits.vaultPath()));
    const bytes: Uint8Array = built.finalized.serialize();
    ensureDir(STATE_DIR);
    writeFileSync(WITHDRAW_TX_FILE, bytes, { mode: 0o600 });
    const params = await liveLedgerParameters().catch(() => null);
    s.withdraw = {
      evmNonce: evmNonce.toString(),
      gas: { ...gas },
      dest: USER,
      refundRecipient: keys.coinPublicKey,
      destErc20Before: destBefore.toString(),
      vaultEvmEthBefore: ethers.formatEther(vaultEth),
      requestId: req.requestId,
      requestNonce: req.requestNonce.toString(),
      build: {
        atUtc: nowUtc(),
        tempSyncSeconds: secs(temp.syncMs),
        buildSeconds: secs(built.buildMs),
        shieldedBalanceMs: built.balanceMs,
        proveSeconds: secs(built.proveMs),
        txBytes: bytes.length,
        identifiers: (built.finalized.identifiers() as string[]).map(String),
        dustSpendsInBrowserTx: dustFeeSpecks(built.finalized) === 0n ? 0 : 'present',
        requiredFeeDust: params ? dustText(BigInt(built.finalized.fees(params))) : null,
        shieldedOnly:
          'balanceTransaction(tempZswapKeys, unprovenCall) from the shielded sub-wallet alone; no DUST wallet',
      },
    };
    saveState(s);
    saveEvidence('b3-1-withdraw-build.json', { step: 'B.3.1', withdraw: s.withdraw });
    log(toJson(s.withdraw));
  } finally {
    await temp.stop();
    keys.clear();
  }
}

// ── B.3.2 withdraw-submit ─────────────────────────────────────────────────────

async function cmdWithdrawSubmit() {
  await setNetwork();
  const s = loadState();
  const w = need(s.withdraw, 'withdraw');
  if (w.submitTx) throw new Error(`already submitted: ${String(w.submitTx.txId)}`);
  const ledger = await import('@midnightntwrk/ledger-v9');
  const tx: Any = (ledger.Transaction as Any).deserialize(
    'signature',
    'proof',
    'binding',
    readFileSync(WITHDRAW_TX_FILE),
  );
  const rt = await loadVault(managedDir());
  const pdp = await publicDataProviderFor(ENDPOINTS);
  const sp = await openSponsor();
  try {
    const dustBefore = await sp.dust();
    const t0 = Date.now();
    const { txId, merged } = await addDustAndSubmit(sp.opened, tx);
    log(`      submitted ${txId}; waiting for the indexer`);
    const fin: Any = await pdp.watchForTxData(txId);
    const fee = dustFeeSpecks(merged);
    const onChain = await openRequests(rt, (await pdp.queryContractState(VAULT)).data, 'withdraw');
    w.submitTx = {
      txId,
      txHash: fin?.txHash,
      blockHeight: fin?.blockHeight,
      status: String(fin?.status),
      seconds: secs(Date.now() - t0),
      atUtc: nowUtc(),
      dustFee: dustText(fee),
      sponsorDustBefore: dustText(dustBefore),
      sponsorDustAfter: dustText(await sp.dust()),
      api: "facade.balanceFinalizedTransaction(tx, sponsorKeys, { ttl: now + 60 s, tokenKindsToBalance: ['dust'] }) -> facade.finalizeRecipe(recipe) (merge) -> facade.submitTransaction",
    };
    w.requestOpenOnChain = onChain.has(String(w.requestId));
    addDust(s, 'startWithdraw', fee);
    saveState(s);
    saveEvidence('b3-2-withdraw-submit.json', { step: 'B.3.2', withdraw: s.withdraw });
    log(toJson(w.submitTx));
    if (String(fin?.status) !== 'SucceedEntirely')
      throw new Error(`the withdrawal did not succeed entirely: ${String(fin?.status)}`);
    if (!w.requestOpenOnChain)
      throw new Error(`the predicted withdraw request ${String(w.requestId)} is not open on chain`);
  } finally {
    await sp.opened.stop();
  }
}

// ── B.3.4 withdraw-complete ───────────────────────────────────────────────────

async function cmdWithdrawComplete() {
  await setNetwork();
  const s = loadState();
  const t = need(s.token, 'token');
  const temp = need(s.temp, 'temp');
  const w = need(s.withdraw, 'withdraw');
  if (w.completeTx) throw new Error(`already settled: ${String(w.completeTx.txId)}`);
  const persist = () => {
    saveState(s);
    saveEvidence('b3-4-withdraw-complete.json', { step: 'B.3.4', withdraw: s.withdraw });
  };
  const relay = await runRelay(s, 'withdraw', persist);
  const circuit = relay.kind === 'never-executed' ? 'refundWithdraw' : 'completeWithdraw';
  const rt = await loadVault(managedDir());
  const sp = await openSponsor();
  try {
    const { providers, lastTx } = await sponsorProvidersRecording(rt, sp);
    const t0 = Date.now();
    const out = await settle(providers, rt, VAULT, circuit, {
      requestId: need(w.requestId, 'withdraw.requestId'),
      event: relay.event,
      serializedOutput: relay.serializedOutput,
      recipientCoinPublicKeyHex: temp.coinPublicKey,
      recipientEncryptionPublicKeyHex: temp.encryptionPublicKey,
    });
    const fee = dustFeeSpecks(lastTx());
    const provider = sepolia();
    try {
      const destAfter = await erc20Balance(provider, t.erc20, USER);
      w.completeTx = {
        circuit,
        attested: relay.kind,
        txId: out.txId,
        txHash: out.txHash,
        blockHeight: out.blockHeight,
        status: out.status,
        seconds: secs(Date.now() - t0),
        atUtc: nowUtc(),
        dustFee: dustText(fee),
        refundMinted: out.minted ? { value: String(out.minted.value) } : null,
      };
      w.destErc20After = destAfter.toString();
      w.destErc20Delta = (destAfter - BigInt(String(w.destErc20Before))).toString();
    } finally {
      provider.destroy();
    }
    addDust(s, circuit, fee);
    persist();
    log(toJson({ completeTx: w.completeTx, destErc20Delta: w.destErc20Delta }));
  } finally {
    await sp.opened.stop();
  }
}

// ── B.4 summary ───────────────────────────────────────────────────────────────

/** B.4: timings, DUST per leg, Sepolia gas and the ETH stranded at the deposit address, from the state. */
async function cmdSummary() {
  const s = loadState();
  const d = need(s.deposit, 'deposit') as Any;
  const w = need(s.withdraw, 'withdraw') as Any;
  const f = need(s.fund, 'fund') as Any;
  const stage = (rec: Any, name: string) =>
    (rec.relay as Any[] | undefined)?.find((r) => r.stage === name)?.atUtc ?? null;
  const wei = (v: unknown) => BigInt(String(v ?? '0'));
  const userFees = wei(f.erc20Tx.feeWei) + wei(f.ethTx.feeWei);
  const sweepSent = wei(f.ethTx.wei);
  const out = {
    step: 'B.4',
    at: nowUtc(),
    token: s.token,
    amount: s.amount,
    timings: {
      fundSeconds: f.seconds,
      depositStartSeconds: d.startTx?.seconds,
      depositSignedAt: stage(d, 'signed'),
      depositBroadcastAt: stage(d, 'broadcast'),
      depositFinalizedAt: stage(d, 'finalized'),
      depositAttestedAt: stage(d, 'attested'),
      depositSignatureAfterS: d.relayResult?.signatureAfterS,
      depositAttestationAfterS: d.relayResult?.attestationAfterS,
      depositCompleteSeconds: d.completeTx?.seconds,
      tempSyncSeconds: (s.tempCheck as Any)?.syncSeconds,
      withdrawBuild: w.build,
      withdrawSubmitSeconds: w.submitTx?.seconds,
      withdrawSignedAt: stage(w, 'signed'),
      withdrawBroadcastAt: stage(w, 'broadcast'),
      withdrawFinalizedAt: stage(w, 'finalized'),
      withdrawAttestedAt: stage(w, 'attested'),
      withdrawSignatureAfterS: w.relayResult?.signatureAfterS,
      withdrawAttestationAfterS: w.relayResult?.attestationAfterS,
      withdrawCompleteSeconds: w.completeTx?.seconds,
      fundToWithdrawCompleteSeconds:
        f.atUtc && w.completeTx?.atUtc
          ? secs(Date.parse(w.completeTx.atUtc) - Date.parse(f.atUtc) + f.seconds * 1000)
          : null,
    },
    dustPerLeg: s.dust,
    dustTotal: Object.values(s.dust ?? {})
      .map(Number)
      .reduce((a, b) => a + b, 0),
    sepolia: {
      userErc20TransferGas: f.erc20Tx.gasUsed,
      userEthTransferGas: f.ethTx.gasUsed,
      userFeesWei: userFees.toString(),
      sweepEthSentWei: sweepSent.toString(),
      userEthSpentWei: (userFees + sweepSent).toString(),
      sweep: d.sweepReceipt,
      strandedAtDepositAddressWei: String(d.sweepReceipt?.strandedWei ?? ''),
      vaultTransfer: w.transferReceipt,
    },
    balances: {
      userErc20BeforeWithdraw: w.destErc20Before,
      userErc20AfterWithdraw: w.destErc20After ?? w.destErc20AfterTransfer,
      userErc20Delta: w.destErc20Delta,
      temporaryWalletFinal: (s.finalCheck as Any)?.balance ?? null,
    },
  };
  saveEvidence('b4-summary.json', out);
  log(toJson(out));
}

// ── status ────────────────────────────────────────────────────────────────────

async function cmdStatus() {
  const s = loadState();
  const provider = sepolia();
  try {
    const out: Json = { at: nowUtc(), stateFile: STATE_FILE, state: s };
    if (s.token && s.depositAddress) {
      const dep = String(s.depositAddress.address);
      out.sepolia = {
        depositAddress: {
          address: dep,
          token: (await erc20Balance(provider, s.token.erc20, dep)).toString(),
          wei: (await provider.getBalance(dep)).toString(),
        },
        user: { token: (await erc20Balance(provider, s.token.erc20, USER)).toString() },
        vaultEvm: {
          eth: ethers.formatEther(await provider.getBalance(VAULT_EVM)),
          pendingNonce: await provider.getTransactionCount(VAULT_EVM, 'pending'),
        },
      };
    }
    log(toJson(out));
  } finally {
    provider.destroy();
  }
}

const COMMANDS: Record<string, () => Promise<void>> = {
  preflight: cmdPreflight,
  derive: cmdDerive,
  fund: cmdFund,
  'deposit-start': cmdDepositStart,
  relay: cmdRelay,
  'deposit-complete': cmdDepositComplete,
  'temp-check': cmdTempCheck,
  'withdraw-build': cmdWithdrawBuild,
  'withdraw-submit': cmdWithdrawSubmit,
  'withdraw-complete': cmdWithdrawComplete,
  summary: cmdSummary,
  status: cmdStatus,
};

const cmd = process.argv[2] ?? '';
const run = COMMANDS[cmd];
if (!run) {
  console.error(`usage: gate.ts <${Object.keys(COMMANDS).join('|')}>`);
  process.exit(2);
}
run().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(`G-BRIDGE ${cmd} FAILED: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  },
);
/* eslint-enable @typescript-eslint/no-explicit-any */

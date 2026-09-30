// The ERC20 vault, driven by the sponsor: the compiled module, the midnight-js providers over the
// sponsor's wallet, and the bridge legs the sponsor pays for.
//
// The vault is acedward/passport PR #4 @ 6c7505a (`contract/contracts/erc20-vault/`, deployed on
// stagenet at 7771c9e5…). Its compiled module and keys are NOT in this repository: they are loaded
// at run time from a directory laid out as the vault's own `managed/` (`Erc20Vault/` and its callee
// `SignetSigner/`, side by side, because the generated JS imports `../../SignetSigner/...`). The
// directory must sit under this repository's root so the generated module resolves
// `@midnight-ntwrk/compact-runtime` from the root install. `verifyVaultKeys` compares every local
// verifier key with the one deployed on chain before anything is proven.
//
// Every leg here is permissionless on the vault (spec, Research "Bridge"): the sponsor submits
// `startDeposit` and `completeDeposit` for a temporary wallet it holds no key of, adds DUST to the
// temporary wallet's own `startWithdraw`, and submits `completeWithdraw`. The only thing a minted
// coin needs from its owner is the owner's PUBLIC encryption key, passed to midnight-js as
// `additionalCoinEncPublicKeyMappings` so the coin's ciphertext is sealed to the owner.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { depositPathOf, hexToBytes, walletRecipient } from '@evm-midnight-transparent/core';

import type { OpenedWallet } from '../sponsor/facade.js';

// ── Types kept loose on purpose: the SDK's types are deep generics; the gate proves the shapes ──

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface VaultEndpoints {
  networkId: string;
  indexerUrl: string;
  indexerWsUrl: string;
  proofServerUrl: string;
}

/** The vault's compiled module and the artefacts midnight-js needs to call and prove it. */
export interface VaultRuntime {
  managedDir: string;
  module: Any;
  compiledContract: Any;
  zkConfigProvider: Any;
  zkConfigRegistry: Any;
  /** `ledger(state.data)` of the generated module. */
  ledger(data: unknown): Any;
  pureCircuits: Any;
}

/** The circuits the bridge legs use. `verifyVaultKeys` checks each against the chain. */
export const BRIDGE_CIRCUITS = [
  'startDeposit',
  'completeDeposit',
  'abandonDeposit',
  'startWithdraw',
  'completeWithdraw',
  'refundWithdraw',
] as const;

/**
 * SHA-256 of the compiled modules the sponsor runs from the key directory: passport 6c7505a compiled
 * with compactc 0.34.0 (deploy/vault-keys builds exactly these bytes; the wallet vendors the same
 * files, packages/wallet/src/vendor/vault/PROVENANCE.md). The directory's verifier keys are checked
 * against the chain, but its JavaScript runs inside the sponsor, next to its seed, so it is checked
 * here before it is imported (audit F-A16). A re-pin of the vault changes these, in review.
 */
export const VAULT_MODULE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  'Erc20Vault/contract/index.js': 'd98e12adb189430b1cc28ff3a6007d7007a7e3c86e718ac92cba51dab4359296',
  'SignetSigner/contract/index.js': '61464470a693cda984e77062536450ccc5e9221ea5be68281a2784f75b5f6a95',
});

export class VaultModuleError extends Error {
  override name = 'VaultModuleError';
}

/** Throws VaultModuleError unless every pinned module of `managedDir` is the reviewed build. */
export function checkVaultModules(managedDir: string): void {
  for (const [rel, want] of Object.entries(VAULT_MODULE_SHA256)) {
    let got: string;
    try {
      got = sha256(readFileSync(join(managedDir, rel)));
    } catch {
      throw new VaultModuleError(`${rel} is missing from the vault key directory`);
    }
    if (got !== want) {
      throw new VaultModuleError(
        `${rel} is not the reviewed build (sha256 ${got.slice(0, 12)}…, expected ${want.slice(0, 12)}…): refusing to run it`,
      );
    }
  }
}

export async function loadVault(managedDir: string): Promise<VaultRuntime> {
  checkVaultModules(managedDir);
  const [{ CompiledContract }, zk] = await Promise.all([
    import('@midnight-ntwrk/compact-js'),
    import('@midnight-ntwrk/midnight-js-node-zk-config-provider'),
  ]);
  const zkPath = join(managedDir, 'Erc20Vault');
  const module: Any = await import(pathToFileURL(join(zkPath, 'contract', 'index.js')).href);
  const compiledContract = (CompiledContract as Any)
    .make('erc20-vault', module.Contract)
    .pipe((CompiledContract as Any).withVacantWitnesses, (CompiledContract as Any).withCompiledFileAssets(zkPath));
  return {
    managedDir,
    module,
    compiledContract,
    zkConfigProvider: new zk.NodeZkConfigProvider(zkPath),
    zkConfigRegistry: await zk.nodeZkConfigRegistry(managedDir),
    ledger: (data) => module.ledger(data),
    pureCircuits: module.pureCircuits,
  };
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** sha256 of every local verifier key next to the deployed one; `ok` when every bridge circuit
 *  and the singleton's `signBidirectional` are byte-identical to the chain. */
export async function verifyVaultKeys(
  rt: VaultRuntime,
  publicDataProvider: Any,
  vaultAddress: string,
  singletonAddress: string,
): Promise<{ ok: boolean; rows: { contract: string; circuit: string; local: string; onChain: string | null }[] }> {
  const rows: { contract: string; circuit: string; local: string; onChain: string | null }[] = [];
  const check = async (contract: string, address: string, dir: string, circuits: readonly string[]) => {
    const state = await publicDataProvider.queryContractState(address);
    if (!state) throw new Error(`no contract state at ${address}`);
    for (const c of circuits) {
      const local = sha256(readFileSync(join(rt.managedDir, dir, 'keys', `${c}.verifier`)));
      const vk = state.operation(c)?.verifierKey as Uint8Array | undefined;
      rows.push({ contract, circuit: c, local, onChain: vk ? sha256(vk) : null });
    }
  };
  await check('vault', vaultAddress, 'Erc20Vault', BRIDGE_CIRCUITS);
  await check('singleton', singletonAddress, 'SignetSigner', ['signBidirectional']);
  return { ok: rows.every((r) => r.local === r.onChain), rows };
}

/** sha256 of the loaded artefacts, for the evidence. */
export function artefactFingerprints(managedDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const bundle of ['Erc20Vault', 'SignetSigner']) {
    out[`${bundle}/contract/index.js`] = sha256(readFileSync(join(managedDir, bundle, 'contract', 'index.js')));
    for (const f of readdirSync(join(managedDir, bundle, 'keys')).sort()) {
      if (f.endsWith('.verifier'))
        out[`${bundle}/keys/${f}`] = sha256(readFileSync(join(managedDir, bundle, 'keys', f)));
    }
  }
  return out;
}

// ── Providers ──────────────────────────────────────────────────────────────────

export async function publicDataProviderFor(e: VaultEndpoints): Promise<Any> {
  const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
  const pdp: Any = indexerPublicDataProvider(e.indexerUrl, e.indexerWsUrl);
  // The indexer can drop a finalisation wait mid-connection ("Premature close"); retry it.
  for (const name of ['watchForTxData', 'watchForDeployTxData']) {
    const fn = pdp[name].bind(pdp);
    pdp[name] = async (...args: unknown[]) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await fn(...args);
        } catch (e) {
          if (attempt > 3 || !/Premature close/.test(String(e))) throw e;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    };
  }
  return pdp;
}

export async function proofProviderFor(rt: VaultRuntime, proofServerUrl: string): Promise<Any> {
  const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
  return httpClientProofProvider(proofServerUrl, rt.zkConfigRegistry);
}

/** The sponsor wallet as midnight-js's wallet and midnight providers: it balances (shielded and
 *  DUST) and submits. `ttlMs` bounds the balancing transaction's time to live. */
export function sponsorWalletProvider(
  opened: OpenedWallet,
  coinPublicKeyHex: string,
  encryptionPublicKeyHex: string,
  ttlMs = 60_000,
) {
  const h = opened.handle as Any;
  return {
    getCoinPublicKey: () => coinPublicKeyHex,
    getEncryptionPublicKey: () => encryptionPublicKeyHex,
    async balanceTx(tx: Any, ttl?: Date) {
      const t = ttl ?? new Date(Date.now() + ttlMs);
      const recipe = await h.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: h.shieldedSecretKeys, dustSecretKey: h.dustSecretKey },
        { ttl: t },
      );
      const signed = await h.wallet.signRecipe(recipe, (payload: Uint8Array) =>
        h.unshieldedKeystore.signDataAsync(payload),
      );
      return h.wallet.finalizeRecipe(signed);
    },
    submitTx: (tx: Any) => h.wallet.submitTransaction(tx),
  };
}

export async function sponsorProviders(
  rt: VaultRuntime,
  opened: OpenedWallet,
  e: VaultEndpoints,
  cpk: string,
  epk: string,
) {
  const walletProvider = sponsorWalletProvider(opened, cpk, epk);
  return {
    publicDataProvider: await publicDataProviderFor(e),
    zkConfigProvider: rt.zkConfigProvider,
    proofProvider: await proofProviderFor(rt, e.proofServerUrl),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

// ── Requests ───────────────────────────────────────────────────────────────────

export type Direction = 'deposit' | 'withdraw';

const mapOf = (d: Direction) => (d === 'deposit' ? 'depositEventMap' : 'withdrawEventMap');

const normHex = (v: unknown): string =>
  v instanceof Uint8Array ? Buffer.from(v).toString('hex') : String(v).replace(/^0x/i, '').toLowerCase();

/** The open requests of one direction (request id -> stored record), from a ledger state. */
export async function openRequests(rt: VaultRuntime, ledgerState: unknown, d: Direction): Promise<Map<string, Any>> {
  const { toSignBidirectionalEventIndex } = await import('./vendor/signet-sdk.js');
  const index = toSignBidirectionalEventIndex(rt.ledger(ledgerState)[mapOf(d)]) as unknown as Map<unknown, Any>;
  return new Map([...index.entries()].map(([k, v]) => [normHex(k), v]));
}

/**
 * The request a circuit call created, read from the call's OWN next contract state: the circuit
 * stores the request under the vault's `signetRequestNonce` and then increments it, so it is the
 * one record whose `requestNonce` is the next state's nonce minus one. Another start landing first
 * cannot be mistaken for it (that would make this call fail on chain instead). Its stored MPC
 * derivation path must be `expectedPathHex` (the recipient's deposit path, or the vault's own
 * path for a withdrawal).
 */
export async function requestOfCall(
  rt: VaultRuntime,
  nextContractState: unknown,
  d: Direction,
  expectedPathHex: string,
): Promise<{ requestId: string; requestNonce: bigint; record: Any }> {
  const nonce = BigInt(rt.ledger(nextContractState).signetRequestNonce) - 1n;
  const ours = [...(await openRequests(rt, nextContractState, d)).entries()].filter(
    ([, r]) => BigInt(r.requestNonce) === nonce,
  );
  if (ours.length !== 1) throw new Error(`expected one ${d} request with nonce ${nonce}, found ${ours.length}`);
  const [requestId, record] = ours[0]!;
  if (normHex(record.path) !== normHex(expectedPathHex)) {
    throw new Error(`the new ${d} request ${requestId} carries path ${normHex(record.path)}, not ${expectedPathHex}`);
  }
  return { requestId, requestNonce: nonce, record };
}

// ── The sponsor's legs ─────────────────────────────────────────────────────────

export interface EvmGas {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  keyVersion: bigint;
}

export interface CallOutcome {
  txId: string;
  txHash?: string;
  blockHeight?: number;
  blockHash?: string;
  status: string;
  result: Any;
}

/** One vault circuit, proven, balanced and paid by the sponsor, submitted and awaited. */
export async function callVault(
  providers: Any,
  rt: VaultRuntime,
  vault: string,
  circuitId: string,
  args: unknown[],
  extra: { additionalCoinEncPublicKeyMappings?: ReadonlyMap<string, string> } = {},
): Promise<CallOutcome> {
  const { submitCallTx } = await import('@midnight-ntwrk/midnight-js-contracts');
  const r: Any = await (submitCallTx as Any)(providers, {
    compiledContract: rt.compiledContract,
    contractAddress: vault,
    circuitId,
    args,
    ...extra,
  });
  const p = r?.public ?? {};
  return {
    txId: String(p.txId ?? ''),
    txHash: p.txHash,
    blockHeight: p.blockHeight,
    blockHash: p.blockHash,
    status: String(p.status),
    result: r,
  };
}

/** `startDeposit` for a wallet recipient: the swap's temporary coin public key. */
export async function startDeposit(
  providers: Any,
  rt: VaultRuntime,
  vault: string,
  input: { evmNonce: bigint; gas: EvmGas; erc20: string; amount: bigint; recipientCoinPublicKeyHex: string },
): Promise<CallOutcome & { requestId: string; requestNonce: bigint }> {
  const recipient = walletRecipient(input.recipientCoinPublicKeyHex);
  const out = await callVault(providers, rt, vault, 'startDeposit', [
    input.evmNonce,
    input.gas.gasLimit,
    input.gas.maxFeePerGas,
    input.gas.maxPriorityFeePerGas,
    input.gas.keyVersion,
    hexToBytes(input.erc20, 20),
    input.amount,
    recipient,
  ]);
  const req = await requestOfCall(
    rt,
    out.result.public.nextContractState,
    'deposit',
    normHex(depositPathOf(recipient)),
  );
  return { ...out, requestId: req.requestId, requestNonce: req.requestNonce };
}

/** The mapping that seals a minted coin to a recipient that is not the paying wallet. */
export const encryptionKeyMapping = (
  coinPublicKeyHex: string,
  encryptionPublicKeyHex: string,
): ReadonlyMap<string, string> => new Map([[normHex(coinPublicKeyHex), normHex(encryptionPublicKeyHex)]]);

/**
 * A settle that may mint to the temporary wallet: `completeDeposit` (the deposited amount) or
 * `completeWithdraw` / `refundWithdraw` (a refund). The attestation is the only gate; the coin's
 * ciphertext is sealed to the recipient's encryption key through `additionalCoinEncPublicKeyMappings`.
 */
export async function settle(
  providers: Any,
  rt: VaultRuntime,
  vault: string,
  circuitId: 'completeDeposit' | 'completeWithdraw' | 'refundWithdraw',
  input: {
    requestId: string;
    event: unknown;
    serializedOutput: Uint8Array;
    recipientCoinPublicKeyHex: string;
    recipientEncryptionPublicKeyHex: string;
  },
): Promise<CallOutcome & { minted: Any }> {
  const out = await callVault(
    providers,
    rt,
    vault,
    circuitId,
    [hexToBytes(input.requestId, 32), input.event, input.serializedOutput, randomMintNonce()],
    {
      additionalCoinEncPublicKeyMappings: encryptionKeyMapping(
        input.recipientCoinPublicKeyHex,
        input.recipientEncryptionPublicKeyHex,
      ),
    },
  );
  const result = out.result?.private?.result;
  const minted =
    result && typeof result === 'object' && 'is_some' in result
      ? result.is_some
        ? result.value
        : null
      : (result ?? null);
  return { ...out, minted };
}

/**
 * The sponsor's half of a temporary wallet's `startWithdraw`: the transaction arrives proven, bound
 * and balanced on its shielded side only (the temporary wallet has no DUST). The sponsor adds a
 * DUST-only balancing transaction (`balanceFinalizedTransaction(..., {tokenKindsToBalance: ['dust']})`),
 * merges it (`finalizeRecipe`) and submits. Returns the submitted transaction's id.
 */
export async function addDustAndSubmit(
  opened: OpenedWallet,
  tx: Any,
  ttlMs = 60_000,
): Promise<{ txId: string; merged: Any }> {
  const h = opened.handle as Any;
  const recipe = await h.wallet.balanceFinalizedTransaction(
    tx,
    { shieldedSecretKeys: h.shieldedSecretKeys, dustSecretKey: h.dustSecretKey },
    { ttl: new Date(Date.now() + ttlMs), tokenKindsToBalance: ['dust'] },
  );
  const merged = await h.wallet.finalizeRecipe(recipe);
  const txId = String(await h.wallet.submitTransaction(merged));
  return { txId, merged };
}

/** A fresh random 32-byte mint nonce: one derived from the public request id would link the coin. */
export const randomMintNonce = (): Uint8Array => new Uint8Array(randomBytes(32));
/* eslint-enable @typescript-eslint/no-explicit-any */

// The live swap backend: the vault's compiled module and keys from the key directory
// (VAULT_MANAGED_DIR, built by deploy/vault-keys/, verified against the chain here at start-up),
// the sponsor wallet paying every DUST fee, the vault's relayer loop (vendored verbatim,
// ./vendor/relayer.ts), Sepolia over JSON-RPC, and the streaming proof provider over the key
// directory (../prover/proving-provider.ts). The swap service (../swaps/service.ts) decides; this
// file only performs, with the exact calls the G-BRIDGE gate proved live (plan 00048 B.2–B.3):
//   - startDeposit / completeDeposit / completeWithdraw / refundWithdraw / abandonDeposit through
//     midnight-js `submitCallTx` (./vault.ts), the settles with `additionalCoinEncPublicKeyMappings`
//     = {tempCoinPk → tempEncPk}, so a minted coin is sealed to the temporary wallet;
//   - the browser's `startWithdraw` gets the sponsor's DUST through the facade's
//     `balanceFinalizedTransaction(tx, keys, {tokenKindsToBalance: ['dust']})` + `finalizeRecipe`;
//   - the relayer options of test/gates/bridge/gate.ts `runRelay` (request paths [0] and [2], the
//     vault's response key and schema, the MPC output cache).

import { createHash } from 'node:crypto';

import {
  depositAddressFor,
  depositPathOf,
  hexToBytes,
  walletRecipient,
  type NetworkProfile,
} from '@evm-midnight-transparent/core';

import type { Logger } from '../log.js';
import type { SponsorSession } from '../sponsor/session.js';
import type { OpenedWallet } from '../sponsor/facade.js';
import type {
  Attestation,
  MidnightTxFacts,
  OpenRequests,
  RebuiltWithdraw,
  ReadWatermark,
  RelayOutcome,
  RequestDetail,
  SwapBackend,
  SwapProver,
  WithdrawCallArgs,
} from '../swaps/backend.js';
import { jsonRpcEvmReader } from './evm.js';
import { rebuildStartWithdraw } from './rebuild.js';
import { relayLoop } from './relay-loop.js';
import {
  addDustAndSubmit,
  callVault,
  checkVaultModules,
  loadVault,
  openRequests as vaultOpenRequests,
  publicDataProviderFor,
  settle as vaultSettle,
  sponsorWalletProvider,
  startDeposit as vaultStartDeposit,
  verifyVaultKeys,
  type VaultRuntime,
} from './vault.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export class BridgeConfigError extends Error {
  override name = 'BridgeConfigError';
}

export interface LiveBackendOptions {
  network: NetworkProfile;
  managedDir: string;
  proofServerUrl: string;
  /** Sepolia JSON-RPC (may carry a key: never logged). */
  evmRpcUrl: string;
  sponsor: SponsorSession;
  log: Logger;
  /** Per-proof timeout, ms. */
  proofTimeoutMs?: number;
}

export interface LiveBackend {
  backend: SwapBackend;
  prover: SwapProver;
  keys: { ok: boolean; rows: { contract: string; circuit: string; local: string; onChain: string | null }[] };
}

const norm = (h: string) => h.replace(/^0x/i, '').toLowerCase();

/**
 * The transaction fields of a vault request (a Signet `SignBidirectionalEvent` whose txParams are an
 * `EvmType2TxParams<2, 0, 0>`: `to` = the ERC20, calldata `transfer(address, amount)` with the amount
 * as its second 32-byte word). Undefined when the record does not have that shape.
 */
export function requestDetail(record: Any): RequestDetail | undefined {
  try {
    const p = record?.txParams;
    const words = p?.calldata?.is_some ? p.calldata.value?.words : undefined;
    if (!(p?.to instanceof Uint8Array) || !Array.isArray(words) || !(words[1] instanceof Uint8Array)) return undefined;
    return {
      erc20: `0x${Buffer.from(p.to).toString('hex')}`,
      amount: BigInt(`0x${Buffer.from(words[1]).toString('hex') || '0'}`),
      evmNonce: BigInt(p.nonce),
      gasLimit: BigInt(p.gasLimit),
      maxFeePerGas: BigInt(p.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(p.maxPriorityFeePerGas),
    };
  } catch {
    return undefined;
  }
}

/**
 * The indexer's latest block: its height and timestamp (ms). The vault's requests are then read AS OF
 * that block, so a read that does not show a request says "absent at this block", never "absent" on
 * an indexer that silently lags (audit S1). Throws when the answer is not a block.
 */
export async function indexerHead(
  indexerUrl: string,
  fetchFn: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<ReadWatermark> {
  const res = await fetchFn(indexerUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'query SPONSOR_HEAD { block { height timestamp } }' }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`the indexer answered ${res.status}`);
  const body = (await res.json()) as { data?: { block?: { height?: unknown; timestamp?: unknown } | null } };
  const b = body.data?.block;
  const height = Number(b?.height);
  const t = Number(b?.timestamp);
  if (!Number.isSafeInteger(height) || height < 0 || !Number.isSafeInteger(t) || t <= 0) {
    throw new Error('the indexer did not answer with a block');
  }
  // The indexer reports milliseconds; a value in seconds is read as such (both are unambiguous).
  return { height, timeMs: t < 1e12 ? t * 1000 : t };
}

/** Load the vault and its keys, verify them against the chain, and compose the backend. Throws a
 *  BridgeConfigError when the keys are not the deployed ones (the sponsor then bridges nothing). */
export async function loadLiveBackend(o: LiveBackendOptions): Promise<LiveBackend> {
  const b = o.network.bridge;
  if (!b.vaultAddress || !b.vaultEvmAddress || !b.signetSingleton || !b.mpcRootPublicKey || !b.mpcOutputCacheUrl) {
    throw new BridgeConfigError('the network profile names no complete bridge (vault, singleton, MPC key, cache)');
  }
  const [{ setNetworkId }, ledger, relayer, sdk, { streamingProver }] = await Promise.all([
    import('@midnight-ntwrk/midnight-js-network-id'),
    import('@midnightntwrk/ledger-v9'),
    import('./vendor/relayer.js'),
    import('./vendor/signet-sdk.js'),
    import('../prover/sponsor-prover.js'),
  ]);
  setNetworkId(o.network.midnightNetworkId as never);
  const vault = norm(b.vaultAddress);
  const singleton = norm(b.signetSingleton);
  const root = sdk.normaliseSecp256k1PublicKey(b.mpcRootPublicKey);
  try {
    checkVaultModules(o.managedDir);
  } catch (e) {
    // A key directory whose JavaScript is not the reviewed build: the bridge stays off (audit F-A16).
    throw new BridgeConfigError((e as Error).message);
  }
  const rt: VaultRuntime = await loadVault(o.managedDir);
  const endpoints = {
    networkId: o.network.midnightNetworkId,
    indexerUrl: o.network.midnight.indexerUrl,
    indexerWsUrl: o.network.midnight.indexerWsUrl,
    proofServerUrl: o.proofServerUrl,
  };
  const pdp: Any = await publicDataProviderFor(endpoints);

  const keys = await verifyVaultKeys(rt, pdp, vault, singleton);
  if (!keys.ok) {
    o.log.error('the vault keys are not the deployed ones: the bridge is off', {
      mismatched: keys.rows.filter((r) => r.local !== r.onChain).map((r) => `${r.contract}/${r.circuit}`),
    });
    throw new BridgeConfigError('the vault keys in VAULT_MANAGED_DIR are not the ones deployed on chain');
  }
  const derivedVaultEvm = sdk.deriveEvmAddress(root, vault, sdk.bytesToHex(rt.pureCircuits.vaultPath()));
  if (derivedVaultEvm.toLowerCase() !== b.vaultEvmAddress.toLowerCase()) {
    throw new BridgeConfigError('the vault EVM address is not the one the MPC key derives for the vault');
  }

  const prover = await streamingProver(o.proofServerUrl, o.managedDir, { timeout: o.proofTimeoutMs, log: o.log });
  const responseKey = sdk.deriveMidnightResponseKey(root as never, vault) as Any;
  const responseSchema: Uint8Array = rt.pureCircuits.vaultResponseSchema();
  const evm = jsonRpcEvmReader(o.evmRpcUrl);

  /** Run `fn` with the sponsor wallet as midnight-js providers (balancing and paying). */
  const withProviders = <T>(fn: (providers: Any, opened: OpenedWallet) => Promise<T>): Promise<T> =>
    o.sponsor.withWallet(async (handle) => {
      const opened = { handle } as OpenedWallet;
      const h = handle as Any;
      const { firstValueFrom, filter } = await import('rxjs');
      const st: Any = await firstValueFrom((h.wallet.state() as Any).pipe(filter((s: Any) => s.isSynced === true)));
      const walletProvider = sponsorWalletProvider(
        opened,
        st.shielded.coinPublicKey.toHexString(),
        st.shielded.encryptionPublicKey.toHexString(),
      );
      const providers = {
        publicDataProvider: pdp,
        zkConfigProvider: rt.zkConfigProvider,
        proofProvider: prover.proofProvider,
        walletProvider,
        midnightProvider: walletProvider,
      };
      return fn(providers, opened);
    });

  const facts = async (txId: string, status?: string, txHash?: string): Promise<MidnightTxFacts> => {
    if (txHash !== undefined && status !== undefined) return { txId, txHash, status };
    const fin: Any = await pdp.watchForTxData(txId);
    return { txId, txHash: fin?.txHash ?? null, status: String(fin?.status ?? status ?? 'unknown') };
  };

  const openRequests = async (kind: 'deposit' | 'withdraw'): Promise<OpenRequests> => {
    // The head first, then the vault's state AS OF that block: the read carries its own watermark
    // (audit S1).
    const asOf = await indexerHead(o.network.midnight.indexerUrl);
    const state = await pdp.queryContractState(vault, { type: 'blockHeight', blockHeight: asOf.height });
    if (!state) throw new Error('no contract state at the vault');
    const records = await vaultOpenRequests(rt, state.data, kind);
    return {
      asOf,
      ids: [...records.keys()],
      pathOf: (id) => {
        const p = records.get(norm(id))?.path;
        return p === undefined ? undefined : p instanceof Uint8Array ? Buffer.from(p).toString('hex') : norm(String(p));
      },
      detailOf: (id) => requestDetail(records.get(norm(id))),
    };
  };

  const attestation = async (kind: 'deposit' | 'withdraw', requestId: string): Promise<Attestation | null> => {
    const reader = relayer.makeReader({
      publicDataProvider: pdp,
      indexerUrl: o.network.midnight.indexerUrl,
      requesterContractAddress: vault,
      requesterRequestsPath: kind === 'deposit' ? [0] : [2],
      signetContractAddress: singleton,
    });
    const cache = new sdk.MpcOutputCacheReader({
      networkId: o.network.midnightNetworkId,
      cacheUrl: b.mpcOutputCacheUrl,
      signetContractAddress: singleton,
    } as never) as Any;
    const id = norm(requestId);
    const cached = await cache.fetchSerializedOutput(id).catch(() => undefined);
    const posts = (await reader.getRespondBidirectionalEvents(id as never)) as readonly unknown[];
    const found = relayer.findAttestation(id, posts, responseKey, responseSchema, cached);
    if (!found) return null;
    return {
      kind: found.kind,
      event: sdk.respondBidirectionalEventToCircuitInput(found.post as never),
      serializedOutput: found.bytes,
    };
  };

  const backend: SwapBackend = {
    evm,
    vaultAddress: vault,
    vaultEvmAddress: b.vaultEvmAddress,
    singletonAddress: singleton,
    depositAddress: (coinPk) => depositAddressFor(root, vault, coinPk),
    depositPathHex: (coinPk) => sdk.bytesToHex(depositPathOf(walletRecipient(coinPk))),
    openRequests,

    startDeposit: (i) =>
      withProviders(async (providers) => {
        const out = await vaultStartDeposit(providers, rt, vault, {
          evmNonce: i.evmNonce,
          gas: i.gas,
          erc20: i.erc20,
          amount: i.amount,
          recipientCoinPublicKeyHex: i.recipientCoinPk,
        });
        return { ...(await facts(out.txId, out.status, out.txHash)), requestId: out.requestId };
      }),

    // The sponsor's own bounded loop (./relay-loop.ts, audit C2) over the vendored relayer's
    // reader and attestation check; one JSON-RPC provider per call, destroyed when it returns.
    async relay(i) {
      const id = norm(i.requestId);
      const reader = relayer.makeReader({
        publicDataProvider: pdp,
        indexerUrl: o.network.midnight.indexerUrl,
        requesterContractAddress: vault,
        requesterRequestsPath: i.kind === 'deposit' ? [0] : [2],
        signetContractAddress: singleton,
      }) as Any;
      const cache = new sdk.MpcOutputCacheReader({
        networkId: o.network.midnightNetworkId,
        cacheUrl: b.mpcOutputCacheUrl,
        signetContractAddress: singleton,
      } as never) as Any;
      const { JsonRpcProvider } = await import('ethers');
      const provider = new JsonRpcProvider(o.evmRpcUrl, undefined, { staticNetwork: true });
      try {
        const r = await relayLoop(
          {
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            log: (line) => o.log.info('relayer', { requestId: i.requestId, line }),
            signedTx: async (rid, signer) => {
              const tx: Any = await reader.getSignedEvmTransaction(rid as never, signer);
              if (!tx) return undefined;
              return {
                hash: String(tx.hash),
                from: String(tx.from),
                nonce: Number(tx.nonce),
                maxFeePerGas: BigInt(tx.maxFeePerGas ?? 0),
                maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas ?? 0),
                serialized: String(tx.serialized),
              };
            },
            receipt: async (hash) => {
              const rc = await provider.getTransactionReceipt(hash);
              return rc ? { hash: rc.hash, blockNumber: rc.blockNumber, status: rc.status } : null;
            },
            latestNonce: (address) => provider.getTransactionCount(address, 'latest'),
            broadcast: async (serialized) => {
              await provider.broadcastTransaction(serialized);
            },
            finalizedBlock: async () => (await provider.getBlock('finalized'))?.number ?? null,
            cachedOutput: (rid) => cache.fetchSerializedOutput(rid) as Promise<Uint8Array | undefined>,
            posts: (rid) => reader.getRespondBidirectionalEvents(rid as never) as Promise<readonly unknown[]>,
            find: (rid, posts, cached) => relayer.findAttestation(rid, posts, responseKey, responseSchema, cached),
          },
          {
            requestId: id,
            expectedSigner: i.expectedSigner,
            signatureTimeoutMs: i.signatureTimeoutMs,
            attestationTimeoutMs: i.attestationTimeoutMs ?? relayer.DEFAULT_ATTESTATION_TIMEOUT_MS,
            intervalMs: 15_000,
            rebroadcastMs: 60_000,
            onProgress: (p) => i.onProgress(p),
          },
        );
        const out: RelayOutcome = {
          kind: r.kind,
          event: sdk.respondBidirectionalEventToCircuitInput(r.post as never),
          serializedOutput: r.serializedOutput,
          signedTxHash: r.signedTxHash,
          signatureAfterMs: r.signatureAfterMs,
          attestationAfterMs: r.attestationAfterMs,
          ...(r.evmTxHash ? { evmTxHash: r.evmTxHash } : {}),
        };
        return out;
      } finally {
        provider.destroy();
      }
    },

    attestation,

    settle: (i) =>
      withProviders(async (providers) => {
        const out = await vaultSettle(providers, rt, vault, i.circuit, {
          requestId: i.requestId,
          event: i.attestation.event,
          serializedOutput: i.attestation.serializedOutput,
          recipientCoinPublicKeyHex: i.recipientCoinPk,
          recipientEncryptionPublicKeyHex: i.recipientEncPk,
        });
        return { ...(await facts(out.txId, out.status, out.txHash)), minted: out.minted !== null };
      }),

    abandonDeposit: (i) =>
      withProviders(async (providers) => {
        const out = await callVault(providers, rt, vault, 'abandonDeposit', [
          hexToBytes(i.requestId, 32),
          i.attestation.event,
          i.attestation.serializedOutput,
        ]);
        return facts(out.txId, out.status, out.txHash);
      }),

    async vaultStateMark(): Promise<string> {
      const state: Any = await pdp.queryContractState(vault);
      if (!state) throw new Error('no contract state at the vault');
      return createHash('sha256')
        .update(Buffer.from(state.serialize() as Uint8Array))
        .digest('hex');
    },

    async rebuildWithdraw(a: WithdrawCallArgs): Promise<RebuiltWithdraw> {
      const r = await rebuildStartWithdraw({ compiledContract: rt.compiledContract, ledger: rt.ledger }, pdp, vault, a);
      return { calls: r.calls, callsDigest: r.callsDigest, outputs: r.outputs, requestId: r.requestId };
    },

    submitWithdraw: (finalTx, hooks) =>
      withProviders(async (_providers, opened) => {
        const tx = (ledger.Transaction as Any).deserialize('signature', 'proof', 'binding', finalTx);
        const { txId } = await addDustAndSubmit(opened, tx, undefined, hooks?.onExpiry);
        return facts(txId);
      }),
  };

  return { backend, prover: prover.swapProver, keys };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

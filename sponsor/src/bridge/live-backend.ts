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
  RelayOutcome,
  SwapBackend,
  SwapProver,
  WithdrawCallArgs,
} from '../swaps/backend.js';
import { jsonRpcEvmReader } from './evm.js';
import { rebuildStartWithdraw } from './rebuild.js';
import {
  addDustAndSubmit,
  callVault,
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
    const state = await pdp.queryContractState(vault);
    if (!state) throw new Error('no contract state at the vault');
    const records = await vaultOpenRequests(rt, state.data, kind);
    return {
      ids: [...records.keys()],
      pathOf: (id) => {
        const p = records.get(norm(id))?.path;
        return p === undefined ? undefined : p instanceof Uint8Array ? Buffer.from(p).toString('hex') : norm(String(p));
      },
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

    async relay(i) {
      const r = await relayer.relayRequest({
        publicDataProvider: pdp,
        indexerUrl: o.network.midnight.indexerUrl,
        requesterContractAddress: vault,
        requesterRequestsPath: i.kind === 'deposit' ? [0] : [2],
        signetContractAddress: singleton,
        requestId: norm(i.requestId),
        expectedSigner: i.expectedSigner,
        mpcResponseKey: responseKey,
        responseSchema,
        evmRpcUrl: o.evmRpcUrl,
        outputCache: { networkId: o.network.midnightNetworkId, cacheUrl: b.mpcOutputCacheUrl },
        signatureTimeoutMs: i.signatureTimeoutMs,
        intervalMs: 15_000,
        onProgress: (p) => i.onProgress(p as never),
        log: (line: string) => o.log.info('relayer', { requestId: i.requestId, line: line.trim() }),
      });
      const out: RelayOutcome = {
        kind: r.kind,
        event: r.event,
        serializedOutput: r.serializedOutput,
        signedTxHash: r.signedTxHash,
        signatureAfterMs: r.signatureAfterMs,
        attestationAfterMs: r.attestationAfterMs,
        ...(r.evmTxHash ? { evmTxHash: r.evmTxHash } : {}),
      };
      return out;
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

    async rebuildWithdraw(a: WithdrawCallArgs): Promise<RebuiltWithdraw> {
      const r = await rebuildStartWithdraw({ compiledContract: rt.compiledContract, ledger: rt.ledger }, pdp, vault, a);
      return { calls: r.calls, callsDigest: r.callsDigest, requestId: r.requestId };
    },

    submitWithdraw: (finalTx) =>
      withProviders(async (_providers, opened) => {
        const tx = (ledger.Transaction as Any).deserialize('signature', 'proof', 'binding', finalTx);
        const { txId } = await addDustAndSubmit(opened, tx);
        return facts(txId);
      }),
  };

  return { backend, prover: prover.swapProver, keys };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

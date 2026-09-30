// The sponsor's entry point (Bun): load the configuration, register every secret with the log
// redactor, open the sponsor wallet (under the funding lock when one is configured), load and verify
// the vault's key directory, resume the swaps in flight, and serve.
//
// Adapted from MN Bank's relay (acedward/passport-evm-dapp @ 911647b, relay/src/main.ts) without its
// key volume and Passport runtime.

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { KernelClient, decodeOffer } from '@evm-midnight-transparent/core';

import { createApp } from './app.js';
import { NonceStore } from './auth/nonces.js';
import { BridgeConfigError, loadLiveBackend, type LiveBackend } from './bridge/live-backend.js';
import { ConfigError, loadConfig } from './config.js';
import { healthCollector, httpProbes } from './health.js';
import { Redactor, createLogger } from './log.js';
import { ProofServerClient } from './prover/client.js';
import { FacadeSponsorSession, openFacadeWallet } from './sponsor/facade.js';
import { DisabledSponsorSession, type SponsorSession } from './sponsor/session.js';
import { SwapService, swapServiceConfig } from './swaps/service.js';
import { StaleCloser } from './swaps/stale.js';
import { JsonFileSwapStore, MemorySwapStore, type SwapStore } from './swaps/store.js';
import { inspectTransaction, makerImbalances } from './validate/inspect.js';
import { SPONSOR_VERSION } from './version.js';

async function main(): Promise<void> {
  const redactor = new Redactor();
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(process.env, (p) => readFileSync(p, 'utf8'));
  } catch (e) {
    const msg = e instanceof ConfigError ? e.message : 'the configuration could not be loaded';
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: `config: ${msg}` })}\n`);
    process.exit(78);
  }
  const { config, secrets } = loaded;
  redactor.addSecret(secrets.sponsorSeedHex);
  redactor.addSecret(secrets.sponsorSeedSource);
  redactor.addSecret(secrets.sepoliaRpcUrl);
  const log = createLogger({ level: config.logLevel, redactor }, { service: 'sponsor', network: config.network.name });

  let sponsor: SponsorSession = new DisabledSponsorSession();
  if (config.sponsor.enabled && secrets.sponsorSeedHex) {
    sponsor = new FacadeSponsorSession(
      {
        seedHex: secrets.sponsorSeedHex,
        endpoints: {
          networkId: config.network.midnightNetworkId,
          indexerUrl: config.network.midnight.indexerUrl,
          indexerWsUrl: config.network.midnight.indexerWsUrl,
          nodeWsUrl: config.network.midnight.nodeWsUrl,
          proofServerUrl: config.proofServerUrl,
        },
        feeBlocksMargin: config.sponsor.feeBlocksMargin,
        fundingLockFile: config.sponsor.fundingLockFile,
        purpose: `evm-midnight-transparent sponsor ${SPONSOR_VERSION} (${config.network.name})`,
      },
      openFacadeWallet,
      log.child({ component: 'sponsor-wallet' }),
    );
    try {
      await sponsor.start();
    } catch (e) {
      log.error('the sponsor wallet could not be started; refusing to start', { error: e });
      process.exit(75);
    }
  }

  let store: SwapStore;
  if (config.swaps.dataDir === ':memory:') {
    log.warn('SPONSOR_DATA_DIR=:memory: swaps are lost on restart');
    store = new MemorySwapStore(config.swaps.retainDays);
  } else {
    store = new JsonFileSwapStore(resolve(config.swaps.dataDir), config.swaps.retainDays);
  }

  // The bridge: the vault's key directory, verified against the chain. Retried until it loads (the
  // indexer may be unreachable at start-up); a key mismatch turns the bridge off for good.
  let live: LiveBackend | null = null;
  let keysVerified: boolean | null = null;
  const managedDir = resolve(config.vaultManagedDir);
  const loadBridge = async (): Promise<boolean> => {
    if (live) return true;
    if (!secrets.sepoliaRpcUrl) {
      log.warn('no Sepolia RPC (SEPOLIA_RPC_URL_FILE): the bridge is off');
      return true;
    }
    if (!existsSync(managedDir)) {
      log.warn('no vault key directory (VAULT_MANAGED_DIR): the bridge is off', { managedDir });
      return true;
    }
    try {
      live = await loadLiveBackend({
        network: config.network,
        managedDir,
        proofServerUrl: config.proofServerUrl,
        evmRpcUrl: secrets.sepoliaRpcUrl,
        sponsor,
        log: log.child({ component: 'bridge' }),
        proofTimeoutMs: config.proofTimeoutSeconds * 1000,
      });
      keysVerified = true;
      log.info('bridge loaded: the vault keys match the chain', { circuits: live.keys.rows.length });
      return true;
    } catch (e) {
      if (e instanceof BridgeConfigError) {
        keysVerified = false;
        log.error('the bridge is off', { error: e });
        return true;
      }
      log.warn('the bridge could not be loaded yet; retrying in 60 s', { error: e });
      return false;
    }
  };
  if (!(await loadBridge())) {
    const retry = setInterval(() => {
      void loadBridge().then((done) => {
        if (done) clearInterval(retry);
      });
    }, 60_000);
    retry.unref?.();
  }

  const kernel = new KernelClient({ baseUrl: config.network.zswap.kernelUrl });
  const swaps = new SwapService({
    config: swapServiceConfig(config),
    store,
    backend: () => live?.backend ?? null,
    prover: () => live?.prover ?? null,
    offers: { offer: (id) => kernel.offer(id), status: (id) => kernel.offerStatus(id) },
    inspect: (bytes, stage) => inspectTransaction(bytes, stage).summary,
    makerImbalances: (offer) => makerImbalances(decodeOffer(offer)),
    makerTxId: (offer) => createHash('sha256').update(decodeOffer(offer)).digest('hex'),
    sponsor: () => sponsor.status(),
    log: log.child({ component: 'swaps' }),
  });
  const closer = new StaleCloser({
    config: {
      enabled: config.staleCloser.enabled,
      intervalMs: config.staleCloser.intervalSeconds * 1000,
      staleAfterMs: config.staleCloser.staleAfterSeconds * 1000,
      maxPerDay: config.staleCloser.maxPerDay,
      minSponsorDustSpecks: config.staleCloser.minSponsorDustSpecks,
    },
    service: swaps,
    sponsor: () => sponsor.status(),
    log: log.child({ component: 'stale-closer' }),
  });

  const nonces = new NonceStore(config.limits.nonceTtlSeconds, config.limits.maxNonces);
  const health = healthCollector({
    network: config.network.name,
    version: SPONSOR_VERSION,
    startedAt: Math.floor(Date.now() / 1000),
    sponsor,
    dustLowSpecks: config.sponsor.dustLowSpecks,
    prover: new ProofServerClient(config.proofServerUrl, config.proofServerVersion),
    lanes: () => swaps.lanes(),
    bridge: () => {
      const cs = closer.status();
      return {
        available: live !== null,
        keysVerified,
        swaps: swaps.countsByState(),
        mpc: swaps.mpcStatus(),
        budget: swaps.budgetStatus(),
        reservations: swaps.reservationsStatus(),
        staleCloser: {
          enabled: cs.enabled,
          lastScanAt: cs.lastScanAt,
          closed24h: cs.closed24h,
          maxPerDay: cs.maxPerDay,
          paused: cs.paused,
        },
      };
    },
    probes: httpProbes({
      kernelUrl: config.network.zswap.kernelUrl,
      batcherUrl: config.network.zswap.batcherUrl,
      vaultEvmAddress: config.network.bridge.vaultEvmAddress,
      sepoliaRpcUrl: secrets.sepoliaRpcUrl,
      log,
    }),
    vaultEvmAddress: config.network.bridge.vaultEvmAddress,
    vaultGasLowWei: config.vaultGasLowWei,
    cacheSeconds: config.healthCacheSeconds,
  });
  const app = createApp({ config, version: SPONSOR_VERSION, log, nonces, swaps, sponsor, health });

  swaps.start();
  closer.start();
  let sweeps = 0;
  const sweeper = setInterval(() => {
    nonces.sweep();
    store.prune(Math.floor(Date.now() / 1000));
    // Never-funded failed swaps: one read each before they are dropped (audit C6), every 10 minutes.
    if (++sweeps % 10 === 0) {
      void swaps.pruneUnfunded().catch((e: unknown) => log.warn('unfunded prune failed', { error: e }));
    }
  }, 60_000);

  const server = Bun.serve({ hostname: config.host, port: config.port, fetch: app.fetch });
  log.info('sponsor listening', {
    host: config.host,
    port: server.port,
    version: SPONSOR_VERSION,
    sponsor: sponsor.status().state,
    bridge: live !== null,
    swaps: store.all().length,
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    clearInterval(sweeper);
    swaps.stop();
    closer.stop();
    await server.stop();
    await sponsor.stop().catch((e: unknown) => log.warn('sponsor stop failed', { error: e }));
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main();

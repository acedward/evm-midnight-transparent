// GET /health: the sponsor's DUST, the proof server, the queue, the kernel and batcher, and the gas
// ETH on the vault's EVM account. Public data only: no URL, no seed, no key. External probes are
// cached for a few seconds so /health cannot be used to flood the services behind it: ONE refresh
// runs at a time and every concurrent request shares it; while it runs, a recent cached report is
// served; app.ts rate-limits the route. Copied from MN Bank's relay (acedward/passport-evm-dapp @
// 911647b, relay/src/health.ts) without its key-volume and Passport bridge sections; L-SPONSOR
// added the bridge section (vault keys verified, swaps by state, the MPC, the stale closer).

import type { HealthResponse } from '@evm-midnight-transparent/core';

import type { Logger } from './log.js';
import type { ProofServerClient } from './prover/client.js';
import type { SponsorSession } from './sponsor/session.js';

export interface ExternalProbes {
  kernel(): Promise<{ reachable: boolean; synced: boolean | null }>;
  batcher(): Promise<{ reachable: boolean }>;
  /** Wei on the vault's EVM account, or null when no Sepolia RPC is configured or it failed. */
  vaultGasWei(): Promise<bigint | null>;
}

const withTimeout = (ms: number) => AbortSignal.timeout(ms);

/** HTTP probes of the kernel, the batcher and Sepolia. `rpcUrl` is a secret: never logged. */
export function httpProbes(opts: {
  kernelUrl: string;
  batcherUrl: string;
  vaultEvmAddress: string;
  sepoliaRpcUrl: string | null;
  fetchImpl?: typeof fetch;
  log: Logger;
  timeoutMs?: number;
}): ExternalProbes {
  const f = opts.fetchImpl ?? fetch;
  const t = opts.timeoutMs ?? 5_000;
  return {
    async kernel() {
      try {
        const r = await f(new URL('/v1/health', opts.kernelUrl), { signal: withTimeout(t) });
        if (!r.ok) return { reachable: false, synced: null };
        const body = (await r.json().catch(() => ({}))) as { synced?: unknown };
        return { reachable: true, synced: typeof body.synced === 'boolean' ? body.synced : null };
      } catch {
        return { reachable: false, synced: null };
      }
    },
    async batcher() {
      try {
        const r = await f(new URL('/health', opts.batcherUrl), { signal: withTimeout(t) });
        return { reachable: r.ok };
      } catch {
        return { reachable: false };
      }
    },
    async vaultGasWei() {
      if (!opts.sepoliaRpcUrl || !opts.vaultEvmAddress) return null;
      try {
        const r = await f(opts.sepoliaRpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_getBalance',
            params: [opts.vaultEvmAddress, 'latest'],
          }),
          signal: withTimeout(t),
        });
        const body = (await r.json()) as { result?: unknown };
        return typeof body.result === 'string' && /^0x[0-9a-fA-F]+$/.test(body.result) ? BigInt(body.result) : null;
      } catch {
        opts.log.warn('vault gas probe failed');
        return null;
      }
    },
  };
}

export interface HealthDeps {
  network: string;
  version: string;
  startedAt: number;
  sponsor: SponsorSession;
  dustLowSpecks: bigint;
  prover: ProofServerClient;
  /** The sponsor's lanes (running and waiting). */
  lanes: () => Record<string, { running: number; waiting: number }>;
  /** The bridge section, when the sponsor drives swaps. */
  bridge?: () => NonNullable<HealthResponse['bridge']>;
  probes: ExternalProbes;
  vaultEvmAddress: string;
  vaultGasLowWei: bigint;
  cacheSeconds: number;
  /** How old a cached report may be and still be served while a refresh runs (default: four cache
   *  periods, at least 60 s). Older than that, callers wait for the one shared refresh. */
  maxStaleSeconds?: number;
  now?: () => number;
}

export function healthCollector(deps: HealthDeps): () => Promise<HealthResponse> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const maxStale = deps.maxStaleSeconds ?? Math.max(60, 4 * deps.cacheSeconds);
  type External = Awaited<ReturnType<typeof probeAll>>;
  let cached: { at: number; external: External } | null = null;
  let refreshing: Promise<{ at: number; external: External }> | null = null;
  const probeAll = async () => {
    const [proof, kernel, batcher, gas] = await Promise.all([
      deps.prover.probe(),
      deps.probes.kernel(),
      deps.probes.batcher(),
      deps.probes.vaultGasWei(),
    ]);
    return { proof, kernel, batcher, gas };
  };
  /** The one refresh in flight: started by the first caller that finds the cache expired. */
  const refresh = () => {
    refreshing ??= probeAll()
      .then((external) => (cached = { at: now(), external }))
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };
  const current = async (): Promise<External> => {
    const age = cached ? now() - cached.at : Infinity;
    if (cached && age < deps.cacheSeconds) return cached.external;
    const pending = refresh();
    // A recent report is served at once while the refresh runs; an old one (or none) waits for it.
    if (cached && age < maxStale) {
      pending.catch(() => {});
      return cached.external;
    }
    return (await pending).external;
  };
  return async () => {
    const { proof, kernel, batcher, gas } = await current();
    const sponsor = deps.sponsor.status();
    const dustLow = sponsor.dustSpecks === null ? sponsor.configured : sponsor.dustSpecks < deps.dustLowSpecks;
    const lanes = deps.lanes();
    const bridge = deps.bridge?.();
    const gasLow = gas === null ? null : gas < deps.vaultGasLowWei;
    const down = !proof.reachable || sponsor.state === 'error';
    const degraded =
      !sponsor.synced ||
      dustLow ||
      !kernel.reachable ||
      !batcher.reachable ||
      gasLow === true ||
      proof.versionMatches === false ||
      (bridge !== undefined && !bridge.available);
    return {
      status: down ? 'down' : degraded ? 'degraded' : 'ok',
      network: deps.network,
      version: deps.version,
      uptimeSeconds: Math.max(0, now() - deps.startedAt),
      sponsor: {
        configured: sponsor.configured,
        state: sponsor.state,
        synced: sponsor.synced,
        dustSpecks: sponsor.dustSpecks === null ? null : sponsor.dustSpecks.toString(10),
        dustLow,
      },
      proofServer: {
        reachable: proof.reachable,
        version: proof.version,
        jobCapacity: proof.jobCapacity,
      },
      queue: {
        jobs: Object.values(lanes).reduce((n, l) => n + l.running + l.waiting, 0),
        lanes,
      },
      kernel,
      batcher,
      vaultGas: { address: deps.vaultEvmAddress, balanceWei: gas === null ? null : gas.toString(10), low: gasLow },
      ...(bridge ? { bridge } : {}),
    };
  };
}

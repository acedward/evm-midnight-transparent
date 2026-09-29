// A sponsor app wired with in-memory fakes, for route tests. No network, no wallet, no ports.
// Copied from MN Bank's relay tests (acedward/passport-evm-dapp @ 911647b, relay/test/harness.ts).

import { type BaseWallet, Wallet } from 'ethers';
import {
  API_PATHS,
  SPONSOR_ACTION_TYPES,
  buildSponsorActionMessage,
  sponsorDomain,
  type HealthResponse,
  type SponsorActionName,
} from '@evm-midnight-transparent/core';

import { defaultCatalogue, type ActionDefinition } from '../src/actions/catalogue.js';
import { createApp } from '../src/app.js';
import { NonceStore } from '../src/auth/nonces.js';
import { loadConfig, type SponsorConfig } from '../src/config.js';
import { createLogger, type Logger } from '../src/log.js';
import { JobQueue } from '../src/queue/jobs.js';
import type { SponsorSession, SponsorStatus } from '../src/sponsor/session.js';

export const LOCAL_TOKENS = {
  tokens: [
    { symbol: 'tA', midnightName: 'shielded-a', decimals: 6, midnightColour: 'aa'.repeat(32) },
    { symbol: 'tB', midnightName: 'shielded-b', decimals: 6, midnightColour: 'bb'.repeat(32) },
  ],
};

export function testConfig(env: Record<string, string> = {}): SponsorConfig {
  return loadConfig({ SPONSOR_NETWORK: 'undeployed', TOKENS_FILE: '/tokens.json', ...env }, () =>
    JSON.stringify(LOCAL_TOKENS),
  ).config;
}

export class FakeSponsor implements SponsorSession {
  constructor(
    public current: SponsorStatus = { configured: true, state: 'synced', synced: true, dustSpecks: 10n ** 20n },
  ) {}
  async start() {}
  async stop() {}
  status() {
    return this.current;
  }
  async withWallet<T>(fn: (w: unknown) => Promise<T>) {
    return fn({ fake: true });
  }
}

export const silentLog = (): Logger & { lines: string[] } => {
  const lines: string[] = [];
  const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) }) as Logger & { lines: string[] };
  log.lines = lines;
  return log;
};

export function harness(
  opts: {
    config?: SponsorConfig;
    sponsor?: SponsorSession;
    catalogue?: Map<SponsorActionName, ActionDefinition>;
  } = {},
) {
  const config = opts.config ?? testConfig();
  const log = silentLog();
  const nonces = new NonceStore(config.limits.nonceTtlSeconds, config.limits.maxNonces);
  const queue = new JobQueue({ ttlSeconds: config.limits.jobTtlSeconds, maxJobs: config.limits.maxJobs, log });
  const catalogue = opts.catalogue ?? defaultCatalogue();
  const health = async (): Promise<HealthResponse> => ({
    status: 'ok',
    network: config.network.name,
    version: 'test',
    uptimeSeconds: 0,
    sponsor: { configured: true, state: 'synced', synced: true, dustSpecks: '1', dustLow: false },
    proofServer: { reachable: true, version: '9.0.0-rc.6', jobCapacity: 10 },
    queue: { jobs: 0, lanes: {} },
    kernel: { reachable: true, synced: true },
    batcher: { reachable: true },
    vaultGas: { address: '', balanceWei: null, low: null },
  });
  const app = createApp({
    config,
    version: 'test',
    log,
    nonces,
    queue,
    catalogue,
    sponsor: opts.sponsor ?? new FakeSponsor(),
    health,
    clientAddress: () => '198.51.100.7',
  });
  return { app, config, log, nonces, queue, catalogue };
}

export const SWAP = '11'.repeat(32);

export function samplePayload(_action: SponsorActionName): Record<string, unknown> {
  return { amount: '1000000', colour: 'bb'.repeat(32) };
}

/** Build a correctly signed request body for `action` (or a deliberately broken one). */
export async function signedBody(
  h: ReturnType<typeof harness>,
  action: SponsorActionName,
  signer: BaseWallet,
  over: {
    owner?: string;
    expiry?: number;
    payload?: Record<string, unknown>;
    nonce?: string;
    network?: string;
    signedAction?: SponsorActionName;
  } = {},
) {
  const def = h.catalogue.get(action)!;
  const payload = over.payload ?? samplePayload(action);
  const nonce = over.nonce ?? (await (await h.app.request(API_PATHS.nonce)).json()).nonce;
  const message = buildSponsorActionMessage({
    action: over.signedAction ?? action,
    network: over.network ?? h.config.network.name,
    owner: over.owner ?? signer.address,
    swap: def.requiresSwap ? SWAP : undefined,
    payload,
    nonce,
    expiry: over.expiry ?? Math.floor(Date.now() / 1000) + 120,
  });
  const signature = await signer.signTypedData(sponsorDomain(), SPONSOR_ACTION_TYPES, message);
  return { ...(def.requiresSwap ? { swap: SWAP } : {}), payload, auth: { message, signature } };
}

export const post = (h: ReturnType<typeof harness>, action: string, body: unknown) =>
  h.app.request(`/v1/actions/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const newWallet = (): BaseWallet => Wallet.createRandom();

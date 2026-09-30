// The sponsor's configuration, from the environment. Copied from MN Bank's relay
// (acedward/passport-evm-dapp @ 911647b, relay/src/config.ts) without its key volume and Passport
// settings; L-SPONSOR added the swap settings (data directory, vault key directory, sweep gas,
// swap limits, the stale closer). Every variable is listed in sponsor/README.md.
//
// Secrets never come from plain env values in production: pass the PATH of a file
// (SPONSOR_SEED_FILE, SEPOLIA_RPC_URL_FILE), which a deployment mounts read-only. Secrets are
// returned separately from the config, are registered with the log redactor at startup, and
// never appear in /health, /v1/config or any log line.

import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
  DEFAULT_EVM_GAS,
  type EvmGasPolicy,
  type NetworkOverrides,
  type NetworkProfile,
  type TokenRegistry,
  isNetworkName,
  registryFor,
  resolveNetwork,
} from '@evm-midnight-transparent/core';

import { LOG_LEVELS, type LogLevel } from './log.js';
import { parseSweepGasLimits } from './swaps/sweep-gas.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface SponsorConfig {
  network: NetworkProfile;
  tokens: TokenRegistry;
  host: string;
  port: number;
  /** Trust the last X-Forwarded-For entry (set by our own reverse proxy) for rate limiting. */
  trustProxy: boolean;
  /** Origins allowed to call the sponsor from a browser (exact match). Empty: no CORS headers. */
  corsOrigins: string[];
  proofServerUrl: string;
  /** Expected proof-server version (health reports a mismatch). */
  proofServerVersion: string;
  sponsor: {
    enabled: boolean;
    /** The wallet SDK's fee margin in blocks: it declares fee × 1.046^margin. MN Bank tested 20
     *  locally and on stagenet (the SDK default of 100 burns far more DUST). */
    feeBlocksMargin: number;
    /** Below this many specks (10^-15 DUST), spending actions are refused and health degrades. */
    dustLowSpecks: bigint;
    /** A shared lock file to take before opening the wallet (live runs on a shared seed). */
    fundingLockFile: string | null;
    /** The owner confirms the seed is dedicated to this sponsor, so no shared lock is needed. */
    dedicated: boolean;
  };
  limits: {
    readsPerMinute: number;
    /** GET /health per client address; monitors poll about once a minute. */
    healthPerMinute: number;
    noncesPerMinute: number;
    /** POST /v1/swaps per client address, and per signing EVM address. */
    opensPerMinute: number;
    opensPerOwnerPerMinute: number;
    /** POST /v1/swaps/:id/prove per client address, and per swap. */
    provesPerMinute: number;
    provesPerSwapPerMinute: number;
    /** POST /v1/swaps/:id/withdraw and /take per client address. */
    writesPerMinute: number;
    authMaxTtlSeconds: number;
    nonceTtlSeconds: number;
    maxNonces: number;
    maxBodyBytes: number;
  };
  swaps: {
    /** Where the swaps are kept (`:memory:` keeps them in memory only: tests and smoke runs). */
    dataDir: string;
    /** Finished swaps are dropped this many days after their last change. */
    retainDays: number;
    /** A new swap's offer must expire at least this far ahead. */
    minOfferTtlSeconds: number;
    maxActivePerOwner: number;
    /** New swaps per EVM address in any 24 hours, whatever became of them (audit C7). */
    maxPerOwnerPerDay: number;
    /** Swaps waiting for funds that have received nothing, all addresses together (audit C6). */
    maxUnfunded: number;
    /** Proofs per swap and purpose (take, withdraw); the withdraw budget is renewed for each new
     *  attempt after a refund or a failed start (audit C11). */
    proofsPerSwap: number;
    /** Every proof of one swap together, over its whole life. */
    proofsTotalPerSwap: number;
    depositPollSeconds: number;
    /** An awaiting_funds swap that received NOTHING fails after this long (re-opening resumes it). */
    fundsWaitSeconds: number;
    /** ... and one that received part of the token, after this long (audit C6). */
    fundsWaitPartialSeconds: number;
    /** Failed swaps that never received anything are dropped after this many days, once their
     *  deposit address is read empty (audit C6). */
    retainUnfundedDays: number;
    /** The sponsorship budget (audit C7): DUST (specks) the sponsor may pay in any 24 hours, 0 for
     *  none, and the estimate of one paid start and one paid settle. */
    dailyDustBudgetSpecks: bigint;
    dustPerStartSpecks: bigint;
    dustPerSettleSpecks: bigint;
    maxDepositAttempts: number;
    /** How often a re-open may re-arm a deposit that failed with its funds at the address (audit C5). */
    maxDepositRearms: number;
    /** Per-token sweep gas limits (symbol -> gas); see swaps/sweep-gas.ts. */
    sweepGasLimits: Record<string, bigint>;
    /** Refuse to open a swap whose sweep ETH would exceed this (a Sepolia gas spike). */
    maxSweepWei: bigint;
  };
  staleCloser: {
    enabled: boolean;
    intervalSeconds: number;
    staleAfterSeconds: number;
    maxPerDay: number;
    minSponsorDustSpecks: bigint;
  };
  /** The vault's compiled module and keys (deploy/vault-keys/ builds it); under the repository root. */
  vaultManagedDir: string;
  proofTimeoutSeconds: number;
  /** The app's display name, served in /v1/config (plan Q10). */
  appName: string;
  /** Health reports low gas when the vault's EVM account holds less than this (wei). */
  vaultGasLowWei: bigint;
  /** The Sepolia gas fields a withdrawal signs (the MPC signs them verbatim), paid from the vault's
   *  shared EVM account. `maxFeePerGas` is the FLOOR: each withdrawal signs max(floor, 2 × the live
   *  base fee + tip), sized when withdraw-params hands it out (audit C2). */
  bridgeGas: EvmGasPolicy;
  /** The most a withdrawal's `maxFeePerGas` may be: above it, withdrawals wait for cheaper gas. */
  bridgeMaxFeeCapWei: bigint;
  /** A signed transfer still not mined after this long, with the base fee above its cap, is stuck:
   *  the next withdrawal takes its nonce (a replacement; audit C2). */
  withdrawStuckAfterSeconds: number;
  /** A started withdrawal the MPC has not signed after this long is stale the same way. */
  withdrawUnsignedStaleSeconds: number;
  healthCacheSeconds: number;
  logLevel: LogLevel;
}

export interface SponsorSecrets {
  /** The sponsor wallet's seed as hex (from a hex seed or a BIP-39 mnemonic). */
  sponsorSeedHex: string | null;
  /** The raw secret text as read, so the redactor can also cut out a mnemonic. */
  sponsorSeedSource: string | null;
  /** A Sepolia RPC URL; it usually carries an API key. */
  sepoliaRpcUrl: string | null;
}

type Env = Record<string, string | undefined>;
type ReadFile = (path: string) => string;

const bool = (v: string | undefined, dflt: boolean, name: string): boolean => {
  if (v === undefined || v.trim() === '') return dflt;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  throw new ConfigError(`${name} must be true or false`);
};

const int = (v: string | undefined, dflt: number, name: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (v === undefined || v.trim() === '') return dflt;
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}]`);
  return n;
};

const big = (v: string | undefined, dflt: bigint, name: string): bigint => {
  if (v === undefined || v.trim() === '') return dflt;
  if (!/^\d+$/.test(v.trim())) throw new ConfigError(`${name} must be a non-negative integer`);
  return BigInt(v.trim());
};

const str = (v: string | undefined): string | undefined => (v === undefined || v.trim() === '' ? undefined : v.trim());

/**
 * Read a secret from `<NAME>_FILE` (preferred) or, for local development only, `<NAME>`.
 * Returns null when neither is set.
 */
function secret(env: Env, readFile: ReadFile, name: string): string | null {
  const file = str(env[`${name}_FILE`]);
  if (file) {
    let text: string;
    try {
      text = readFile(file);
    } catch {
      throw new ConfigError(`${name}_FILE cannot be read`);
    }
    return text;
  }
  return str(env[name]) ?? null;
}

/**
 * The sponsor seed from a secret file's text. Accepts a hex seed, a BIP-39 mnemonic, or an
 * env-style file with one `WALLET=`, `SEED=` or `MNEMONIC=` line (the format of the shared
 * test wallets). Never echoes the value in an error.
 */
export function parseSponsorSeed(text: string): string {
  let value = text.trim();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(WALLET|SEED|MNEMONIC|SPONSOR_SEED)\s*=\s*(.*)$/.exec(line);
    if (m) value = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
  }
  if (/^(0x)?[0-9a-fA-F]{64,128}$/.test(value) && value.replace(/^0x/, '').length % 2 === 0) {
    return value.replace(/^0x/, '').toLowerCase();
  }
  const words = value.split(/\s+/).filter(Boolean);
  if ([12, 15, 18, 21, 24].includes(words.length)) {
    const mnemonic = words.join(' ').toLowerCase();
    if (!validateMnemonic(mnemonic, wordlist))
      throw new ConfigError('the sponsor seed file holds an invalid BIP-39 mnemonic');
    return Buffer.from(mnemonicToSeedSync(mnemonic, '')).toString('hex');
  }
  throw new ConfigError('the sponsor seed file must hold a hex seed or a BIP-39 mnemonic');
}

function overridesFromEnv(env: Env): NetworkOverrides {
  const pick = <T extends Record<string, string | undefined>>(o: T): Partial<Record<keyof T, string>> =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<Record<keyof T, string>>;
  const overrides: NetworkOverrides = {
    midnight: pick({
      nodeUrl: str(env.MIDNIGHT_NODE_URL),
      nodeWsUrl: str(env.MIDNIGHT_NODE_WS_URL),
      indexerUrl: str(env.MIDNIGHT_INDEXER_URL),
      indexerWsUrl: str(env.MIDNIGHT_INDEXER_WS_URL),
      explorerUrl: str(env.MIDNIGHT_EXPLORER_URL),
    }),
    zswap: pick({
      kernelUrl: str(env.ZSWAP_KERNEL_URL),
      batcherUrl: str(env.ZSWAP_BATCHER_URL),
      batcherTarget: str(env.ZSWAP_BATCHER_TARGET),
      siteUrl: str(env.ZSWAP_SITE_URL),
    }),
    bridge: pick({
      vaultAddress: str(env.BRIDGE_VAULT_ADDRESS)?.replace(/^0x/, '').toLowerCase(),
      vaultEvmAddress: str(env.BRIDGE_VAULT_EVM_ADDRESS),
      signetSingleton: str(env.BRIDGE_SIGNET_SINGLETON)?.replace(/^0x/, '').toLowerCase(),
      mpcRootPublicKey: str(env.BRIDGE_MPC_ROOT_PUBLIC_KEY),
      mpcOutputCacheUrl: str(env.BRIDGE_MPC_OUTPUT_CACHE_URL),
      explorerUrl: str(env.BRIDGE_EXPLORER_URL),
    }),
  };
  const midnightNetworkId = str(env.MIDNIGHT_NETWORK_ID);
  if (midnightNetworkId) overrides.midnightNetworkId = midnightNetworkId;
  return overrides;
}

export function loadConfig(env: Env, readFile: ReadFile): { config: SponsorConfig; secrets: SponsorSecrets } {
  const networkName = str(env.SPONSOR_NETWORK);
  if (!networkName || !isNetworkName(networkName))
    throw new ConfigError('SPONSOR_NETWORK must be "undeployed" or "stagenet"');
  let network: NetworkProfile;
  try {
    network = resolveNetwork(networkName, overridesFromEnv(env));
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }

  let tokenConfig: unknown;
  const tokensFile = str(env.TOKENS_FILE);
  if (tokensFile) {
    try {
      tokenConfig = JSON.parse(readFile(tokensFile));
    } catch {
      throw new ConfigError('TOKENS_FILE cannot be read as JSON');
    }
  }
  let tokens: TokenRegistry;
  try {
    tokens = registryFor(network.name, tokenConfig);
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }

  const logLevel = (str(env.LOG_LEVEL) ?? 'info') as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);

  const proofServerUrl = str(env.MIDNIGHT_PROOF_SERVER_URL) ?? 'http://proof-server:6300';
  try {
    new URL(proofServerUrl);
  } catch {
    throw new ConfigError('MIDNIGHT_PROOF_SERVER_URL is not a URL');
  }

  const sponsorEnabled = bool(env.SPONSOR_ENABLED, false, 'SPONSOR_ENABLED');
  const dustLowSpecks = big(env.SPONSOR_DUST_LOW_SPECKS, 10n * 10n ** 15n, 'SPONSOR_DUST_LOW_SPECKS');
  const fundingLockFile = str(env.SPONSOR_FUNDING_LOCK_FILE) ?? null;
  const dedicated = bool(env.SPONSOR_DEDICATED_WALLET, false, 'SPONSOR_DEDICATED_WALLET');

  const config: SponsorConfig = {
    network,
    tokens,
    host: str(env.SPONSOR_HOST) ?? '0.0.0.0',
    port: int(env.SPONSOR_PORT, 8080, 'SPONSOR_PORT', 1, 65535),
    trustProxy: bool(env.SPONSOR_TRUST_PROXY, false, 'SPONSOR_TRUST_PROXY'),
    corsOrigins: (str(env.SPONSOR_CORS_ORIGINS) ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    proofServerUrl,
    proofServerVersion: str(env.PROOF_SERVER_EXPECTED_VERSION) ?? '9.0.0-rc.6',
    sponsor: {
      enabled: sponsorEnabled,
      feeBlocksMargin: int(env.SPONSOR_FEE_BLOCKS_MARGIN, 20, 'SPONSOR_FEE_BLOCKS_MARGIN', 1, 1000),
      dustLowSpecks,
      fundingLockFile,
      dedicated,
    },
    limits: {
      readsPerMinute: int(env.RATE_LIMIT_READS_PER_MIN, 240, 'RATE_LIMIT_READS_PER_MIN', 1),
      healthPerMinute: int(env.RATE_LIMIT_HEALTH_PER_MIN, 60, 'RATE_LIMIT_HEALTH_PER_MIN', 1),
      noncesPerMinute: int(env.RATE_LIMIT_NONCES_PER_MIN, 30, 'RATE_LIMIT_NONCES_PER_MIN', 1),
      opensPerMinute: int(env.RATE_LIMIT_OPENS_PER_MIN, 10, 'RATE_LIMIT_OPENS_PER_MIN', 1),
      opensPerOwnerPerMinute: int(env.RATE_LIMIT_OPENS_PER_OWNER_PER_MIN, 5, 'RATE_LIMIT_OPENS_PER_OWNER_PER_MIN', 1),
      provesPerMinute: int(env.RATE_LIMIT_PROVES_PER_MIN, 20, 'RATE_LIMIT_PROVES_PER_MIN', 1),
      provesPerSwapPerMinute: int(env.RATE_LIMIT_PROVES_PER_SWAP_PER_MIN, 6, 'RATE_LIMIT_PROVES_PER_SWAP_PER_MIN', 1),
      writesPerMinute: int(env.RATE_LIMIT_WRITES_PER_MIN, 20, 'RATE_LIMIT_WRITES_PER_MIN', 1),
      authMaxTtlSeconds: int(env.AUTH_MAX_TTL_SECONDS, 600, 'AUTH_MAX_TTL_SECONDS', 30, 3600),
      nonceTtlSeconds: int(env.AUTH_NONCE_TTL_SECONDS, 600, 'AUTH_NONCE_TTL_SECONDS', 30, 3600),
      maxNonces: int(env.AUTH_MAX_NONCES, 50_000, 'AUTH_MAX_NONCES', 100),
      maxBodyBytes: int(env.SPONSOR_MAX_BODY_BYTES, 2_097_152, 'SPONSOR_MAX_BODY_BYTES', 1024),
    },
    swaps: {
      dataDir: str(env.SPONSOR_DATA_DIR) ?? 'sponsor-data',
      retainDays: int(env.SWAP_RETAIN_DAYS, 30, 'SWAP_RETAIN_DAYS', 1, 3650),
      minOfferTtlSeconds: int(env.SWAP_MIN_OFFER_TTL_SECONDS, 1800, 'SWAP_MIN_OFFER_TTL_SECONDS', 0, 86_400),
      maxActivePerOwner: int(env.SWAP_MAX_ACTIVE_PER_OWNER, 3, 'SWAP_MAX_ACTIVE_PER_OWNER', 1, 100),
      maxPerOwnerPerDay: int(env.SWAP_MAX_PER_OWNER_PER_DAY, 10, 'SWAP_MAX_PER_OWNER_PER_DAY', 1, 10_000),
      maxUnfunded: int(env.SWAP_MAX_UNFUNDED, 100, 'SWAP_MAX_UNFUNDED', 1, 100_000),
      proofsPerSwap: int(env.SWAP_PROOFS_PER_SWAP, 12, 'SWAP_PROOFS_PER_SWAP', 1, 1000),
      proofsTotalPerSwap: int(env.SWAP_PROOFS_TOTAL_PER_SWAP, 48, 'SWAP_PROOFS_TOTAL_PER_SWAP', 1, 10_000),
      depositPollSeconds: int(env.DEPOSIT_POLL_SECONDS, 15, 'DEPOSIT_POLL_SECONDS', 2, 3600),
      fundsWaitSeconds: int(env.SWAP_FUNDS_WAIT_SECONDS, 10_800, 'SWAP_FUNDS_WAIT_SECONDS', 60),
      fundsWaitPartialSeconds: int(env.SWAP_FUNDS_WAIT_PARTIAL_SECONDS, 86_400, 'SWAP_FUNDS_WAIT_PARTIAL_SECONDS', 60),
      retainUnfundedDays: int(env.SWAP_RETAIN_UNFUNDED_DAYS, 2, 'SWAP_RETAIN_UNFUNDED_DAYS', 1, 3650),
      dailyDustBudgetSpecks: big(env.SPONSOR_DAILY_DUST_BUDGET, 500n, 'SPONSOR_DAILY_DUST_BUDGET') * 10n ** 15n,
      dustPerStartSpecks: big(env.SWAP_DUST_PER_START_SPECKS, 2_200_000_000_000_000n, 'SWAP_DUST_PER_START_SPECKS'),
      dustPerSettleSpecks: big(env.SWAP_DUST_PER_SETTLE_SPECKS, 400_000_000_000_000n, 'SWAP_DUST_PER_SETTLE_SPECKS'),
      maxDepositAttempts: int(env.DEPOSIT_MAX_ATTEMPTS, 3, 'DEPOSIT_MAX_ATTEMPTS', 1, 10),
      maxDepositRearms: int(env.DEPOSIT_MAX_REARMS, 3, 'DEPOSIT_MAX_REARMS', 0, 10),
      sweepGasLimits: (() => {
        try {
          return parseSweepGasLimits(str(env.SWEEP_GAS_LIMITS));
        } catch (e) {
          throw new ConfigError((e as Error).message);
        }
      })(),
      maxSweepWei: big(env.SWEEP_MAX_WEI, 5_000_000_000_000_000n, 'SWEEP_MAX_WEI'),
    },
    staleCloser: {
      enabled: bool(env.STALE_CLOSER_ENABLED, true, 'STALE_CLOSER_ENABLED'),
      intervalSeconds: int(env.STALE_CLOSER_INTERVAL_SECONDS, 300, 'STALE_CLOSER_INTERVAL_SECONDS', 10),
      staleAfterSeconds: int(env.STALE_AFTER_SECONDS, 900, 'STALE_AFTER_SECONDS', 60),
      maxPerDay: int(env.STALE_CLOSER_MAX_PER_DAY, 48, 'STALE_CLOSER_MAX_PER_DAY', 0, 10_000),
      minSponsorDustSpecks: big(env.STALE_CLOSER_MIN_DUST_SPECKS, 2n * dustLowSpecks, 'STALE_CLOSER_MIN_DUST_SPECKS'),
    },
    vaultManagedDir: str(env.VAULT_MANAGED_DIR) ?? 'vault-managed',
    proofTimeoutSeconds: int(env.PROOF_TIMEOUT_SECONDS, 900, 'PROOF_TIMEOUT_SECONDS', 30, 3600),
    appName: str(env.APP_NAME) ?? 'EVM Midnight Swap',
    vaultGasLowWei: big(env.VAULT_GAS_LOW_WEI, 2_000_000_000_000_000n, 'VAULT_GAS_LOW_WEI'),
    bridgeGas: {
      gasLimit: big(env.BRIDGE_EVM_GAS_LIMIT, DEFAULT_EVM_GAS.gasLimit, 'BRIDGE_EVM_GAS_LIMIT'),
      maxFeePerGas: big(env.BRIDGE_EVM_MAX_FEE_PER_GAS, DEFAULT_EVM_GAS.maxFeePerGas, 'BRIDGE_EVM_MAX_FEE_PER_GAS'),
      maxPriorityFeePerGas: big(
        env.BRIDGE_EVM_MAX_PRIORITY_FEE_PER_GAS,
        DEFAULT_EVM_GAS.maxPriorityFeePerGas,
        'BRIDGE_EVM_MAX_PRIORITY_FEE_PER_GAS',
      ),
      keyVersion: DEFAULT_EVM_GAS.keyVersion,
    },
    bridgeMaxFeeCapWei: big(env.BRIDGE_EVM_MAX_FEE_CAP_WEI, 100_000_000_000n, 'BRIDGE_EVM_MAX_FEE_CAP_WEI'),
    withdrawStuckAfterSeconds: int(env.WITHDRAW_STUCK_AFTER_SECONDS, 1_800, 'WITHDRAW_STUCK_AFTER_SECONDS', 60),
    withdrawUnsignedStaleSeconds: int(
      env.WITHDRAW_UNSIGNED_STALE_SECONDS,
      7_200,
      'WITHDRAW_UNSIGNED_STALE_SECONDS',
      1_200,
    ),
    healthCacheSeconds: int(env.HEALTH_CACHE_SECONDS, 15, 'HEALTH_CACHE_SECONDS', 0, 600),
    logLevel,
  };

  const sponsorSeedSource = secret(env, readFile, 'SPONSOR_SEED');
  const sponsorSeedHex = sponsorSeedSource === null ? null : parseSponsorSeed(sponsorSeedSource);
  const sepoliaRpcUrl = secret(env, readFile, 'SEPOLIA_RPC_URL')?.trim() ?? null;
  if (sepoliaRpcUrl !== null) {
    try {
      new URL(sepoliaRpcUrl);
    } catch {
      throw new ConfigError('the Sepolia RPC URL is not a URL');
    }
  }

  if (sponsorEnabled && sponsorSeedHex === null) throw new ConfigError('SPONSOR_ENABLED needs SPONSOR_SEED_FILE');
  // Live networks: a seed shared with other tools must be taken under the shared lock, and a
  // dedicated seed must be declared as such. The sponsor never opens a live wallet otherwise.
  if (sponsorEnabled && network.name !== 'undeployed' && !fundingLockFile && !dedicated) {
    throw new ConfigError(
      'on a live network the sponsor needs SPONSOR_FUNDING_LOCK_FILE (a shared seed) or SPONSOR_DEDICATED_WALLET=true',
    );
  }

  return { config, secrets: { sponsorSeedHex, sponsorSeedSource, sepoliaRpcUrl } };
}

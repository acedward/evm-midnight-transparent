// A sponsor app wired with in-memory fakes (./fakes.ts), for route and service tests. No network,
// no wallet, no ledger, no ports. The configuration is stagenet's (its 8 vault tokens), so the
// swaps use real colours and ERC20 addresses.

import { type BaseWallet, Wallet } from 'ethers';
import {
  SPONSOR_ACTION_TYPES,
  SWAP_PATHS,
  buildSponsorActionMessage,
  sponsorDomain,
  stagenetRegistry,
  type HealthResponse,
  type OpenSwapPayload,
  type OpenSwapResponse,
  type TokenEntry,
} from '@evm-midnight-transparent/core';

import { createApp } from '../src/app.js';
import { NonceStore } from '../src/auth/nonces.js';
import { loadConfig, type SponsorConfig } from '../src/config.js';
import { createLogger, type Logger } from '../src/log.js';
import type { SponsorSession, SponsorStatus } from '../src/sponsor/session.js';
import { SwapService, swapServiceConfig, type SwapServiceConfig } from '../src/swaps/service.js';
import { MemorySwapStore, type SwapStore } from '../src/swaps/store.js';
import {
  FakeOffers,
  FakeProver,
  FakeVault,
  encodeFakeTx,
  fakeCoinCommitment,
  fakeInspect,
  fakeWithdrawCalls,
  takeTx,
  withdrawTx,
} from './fakes.js';
import type { TxSummary } from '../src/validate/summary.js';

export const LOCAL_TOKENS = {
  tokens: [
    { symbol: 'tA', midnightName: 'shielded-a', decimals: 6, midnightColour: 'aa'.repeat(32) },
    { symbol: 'tB', midnightName: 'shielded-b', decimals: 6, midnightColour: 'bb'.repeat(32) },
  ],
};

export function testConfig(env: Record<string, string> = {}): SponsorConfig {
  return loadConfig({ SPONSOR_NETWORK: 'stagenet', SPONSOR_DATA_DIR: ':memory:', ...env }, () => '').config;
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

const REG = stagenetRegistry();
export const tok = (symbol: string): TokenEntry => REG.bySymbol(symbol)!;
/** The G-TAKE bid: the maker gives 1 wUSDC and wants 104.166667 wStkA. */
export const BID = {
  offerId: '9ed57eecd6bab01858def5d5e50142d0db31cd5c5f4847a39cc3027833b0a00b',
  pay: { token: tok('stkA'), amount: 104_166_667n },
  receive: { token: tok('USDC'), amount: 1_000_000n },
};

export interface Harness {
  app: ReturnType<typeof createApp>;
  config: SponsorConfig;
  log: Logger & { lines: string[] };
  nonces: NonceStore;
  vault: FakeVault;
  prover: FakeProver;
  offers: FakeOffers;
  store: SwapStore;
  swaps: SwapService;
  sponsor: FakeSponsor;
  now: { ms: number };
}

export function harness(
  opts: {
    config?: SponsorConfig;
    store?: SwapStore;
    vault?: FakeVault;
    offers?: FakeOffers;
    service?: Partial<SwapServiceConfig>;
    bridge?: boolean;
    /** The caller's address the app sees (mutable: per-client tests change it). */
    client?: { address: string };
  } = {},
): Harness {
  const config = opts.config ?? testConfig();
  const log = silentLog();
  const nonces = new NonceStore(config.limits.nonceTtlSeconds, config.limits.maxNonces);
  const vault = opts.vault ?? new FakeVault();
  const prover = new FakeProver();
  const offers = opts.offers ?? new FakeOffers();
  const store = opts.store ?? new MemorySwapStore();
  const sponsor = new FakeSponsor();
  const now = { ms: Date.now() };
  const swaps = new SwapService({
    config: {
      ...swapServiceConfig(config),
      depositPollMs: 1_000_000,
      // Every pass reads a fresh swap's address (tests call pollDeposits by hand).
      pollBackoffMs: { fast: 0, medium: 60_000, slow: 300_000 },
      ...opts.service,
    },
    store,
    backend: () => (opts.bridge === false ? null : vault),
    prover: () => (opts.bridge === false ? null : prover),
    offers,
    inspect: (bytes) => fakeInspect(bytes),
    makerImbalances: offers.makerImbalances,
    makerTxId: offers.makerTxId,
    coinCommitment: fakeCoinCommitment,
    sponsor: () => sponsor.status(),
    log,
    now: () => now.ms,
  });
  const health = async (): Promise<HealthResponse> => ({
    status: 'ok',
    network: config.network.name,
    version: 'test',
    uptimeSeconds: 0,
    sponsor: { configured: true, state: 'synced', synced: true, dustSpecks: '1', dustLow: false },
    proofServer: { reachable: true, version: '9.0.0-rc.6', jobCapacity: 10 },
    queue: { jobs: 0, lanes: swaps.lanes() },
    kernel: { reachable: true, synced: true },
    batcher: { reachable: true },
    vaultGas: { address: '', balanceWei: null, low: null },
  });
  const app = createApp({
    config,
    version: 'test',
    log,
    nonces,
    swaps,
    sponsor,
    health,
    clientAddress: () => opts.client?.address ?? '198.51.100.7',
    now: () => Math.floor(now.ms / 1000),
  });
  return { app, config, log, nonces, vault, prover, offers, store, swaps, sponsor, now };
}

export const newWallet = (): BaseWallet => Wallet.createRandom();
export const hex32 = (seed: string) => Buffer.from(seed.padEnd(32, '.').slice(0, 32)).toString('hex');

export interface SwapInput {
  user: BaseWallet;
  swapId: string;
  payload: OpenSwapPayload;
}

/** A swap of the G-TAKE bid for `user` (the offer is added to the fake book). */
export function bidSwap(h: Harness, user: BaseWallet = newWallet(), tag = 'a'): SwapInput {
  h.offers.add({
    offerId: BID.offerId,
    give: { colour: BID.receive.token.midnightColour, amount: BID.receive.amount },
    want: { colour: BID.pay.token.midnightColour, amount: BID.pay.amount },
  });
  return {
    user,
    swapId: hex32(`swap-${tag}`),
    payload: {
      offerId: BID.offerId,
      evmAddress: user.address,
      pay: { colour: BID.pay.token.midnightColour, amount: BID.pay.amount.toString() },
      receive: { colour: BID.receive.token.midnightColour, amount: BID.receive.amount.toString() },
      tempCoinPk: hex32(`coin-${tag}`),
      tempEncPk: hex32(`enc-${tag}`),
    },
  };
}

/** A signed open-swap body (or a deliberately broken one). */
export async function openBody(
  h: Harness,
  s: SwapInput,
  over: {
    signer?: BaseWallet;
    owner?: string;
    expiry?: number;
    nonce?: string;
    network?: string;
    action?: string;
    signedSwap?: string;
    signedPayload?: Record<string, unknown>;
    /** Leave the owner's Sepolia balances as they are (by default the owner holds the pay amount and
     *  the sweep ETH, which an open checks: audit R4). */
    ownerUnfunded?: boolean;
  } = {},
) {
  if (!over.ownerUnfunded) fundOwner(h, s);
  const nonce = over.nonce ?? ((await (await h.app.request(SWAP_PATHS.nonce)).json()) as { nonce: string }).nonce;
  const message = buildSponsorActionMessage({
    action: over.action ?? 'open-swap',
    network: over.network ?? h.config.network.name,
    owner: over.owner ?? s.user.address,
    swap: over.signedSwap ?? s.swapId,
    payload: over.signedPayload ?? s.payload,
    nonce,
    expiry: over.expiry ?? Math.floor(h.now.ms / 1000) + 120,
  });
  const signature = await (over.signer ?? s.user).signTypedData(sponsorDomain(), SPONSOR_ACTION_TYPES, message);
  return { swap: s.swapId, payload: s.payload, auth: { message, signature } };
}

/** The owner holds the pay amount of the pay token and 1 ETH on Sepolia (what an open checks). */
export function fundOwner(h: Harness, s: SwapInput) {
  const erc20 = h.config.tokens.byColour(s.payload.pay.colour)?.sepoliaAddress;
  const owner = s.payload.evmAddress;
  if (erc20) {
    const key = `${erc20.toLowerCase()}/${owner.toLowerCase()}`;
    const have = h.vault.evm.erc20.get(key) ?? 0n;
    if (have < BigInt(s.payload.pay.amount)) h.vault.evm.setErc20(erc20, owner, BigInt(s.payload.pay.amount));
  }
  if ((h.vault.evm.eth.get(owner.toLowerCase()) ?? 0n) < 10n ** 18n) h.vault.evm.setEth(owner, 10n ** 18n);
}

export const post = (h: Harness, path: string, body: unknown, token?: string) =>
  h.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

export const get = (h: Harness, path: string, token?: string) =>
  h.app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

/** Open the swap; returns the response (throws when it is not 201/200). */
export async function openSwap(h: Harness, s: SwapInput): Promise<OpenSwapResponse> {
  const res = await post(h, SWAP_PATHS.swaps, await openBody(h, s));
  if (res.status !== 201 && res.status !== 200) throw new Error(`open answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as OpenSwapResponse;
}

/** Fund the deposit address exactly (the ERC20 amount and the sweep ETH). */
export function fund(h: Harness, o: OpenSwapResponse, extra: { erc20?: bigint; eth?: bigint } = {}) {
  h.vault.evm.setErc20(o.erc20Address, o.depositAddress, BigInt(o.amount) + (extra.erc20 ?? 0n));
  h.vault.evm.setEth(o.depositAddress, BigInt(o.sweepGas.ethWei) + (extra.eth ?? 0n));
}

/** Open, fund, and drive the deposit to `minted`. */
export async function mintedSwap(
  h: Harness,
  s: SwapInput = bidSwap(h),
): Promise<{ s: SwapInput; o: OpenSwapResponse; token: string }> {
  const o = await openSwap(h, s);
  fund(h, o);
  await h.swaps.pollDeposits();
  await h.swaps.idle();
  const rec = h.store.get(s.swapId)!;
  if (rec.state !== 'minted') throw new Error(`expected minted, got ${rec.state}`);
  return { s, o, token: o.swapToken };
}

export const txHex = (s: TxSummary) => encodeFakeTx(s);

/** The G-TAKE bid's take: +pay -receive. */
export const bidTake = (over: Partial<TxSummary> = {}) =>
  takeTx(
    { colour: BID.pay.token.midnightColour, amount: BID.pay.amount },
    { colour: BID.receive.token.midnightColour, amount: BID.receive.amount },
    over,
  );

/** A coin paid to the temporary wallet, as `/prove` discloses it (audit R1). */
export interface WalletCoin {
  nonce: string;
  colour: string;
  value: string;
}

export const coinOutput = (coin: WalletCoin, coinPk: string) => ({
  commitment: fakeCoinCommitment({ ...coin, value: BigInt(coin.value) }, coinPk),
  contract: null,
});

/** The G-TAKE bid's take for swap `s` as the wallet builds it: the wallet's coin in, the received
 *  coin out to the temporary wallet, and the disclosure of that coin (audit R1). */
export function bidTakeFor(s: SwapInput, over: Partial<TxSummary> = {}) {
  const received: WalletCoin = {
    nonce: hex32(`received-${s.swapId.slice(0, 8)}`),
    colour: BID.receive.token.midnightColour,
    value: BID.receive.amount.toString(),
  };
  const tx = bidTake({
    shielded: {
      inputs: [{ nullifier: hex32(`pay-coin-${s.swapId.slice(0, 8)}`), contract: null }],
      outputs: [coinOutput(received, s.payload.tempCoinPk)],
    },
    ...over,
  });
  return { tx, walletOutputs: [received] };
}

/** The `/prove` body of `bidTakeFor(s)`. */
export const takeBody = (s: SwapInput, over: Partial<TxSummary> = {}) => {
  const t = bidTakeFor(s, over);
  return { purpose: 'take', tx: encodeFakeTx(t.tx), walletOutputs: t.walletOutputs };
};

/** A startWithdraw for `kind` as the browser would build it on the fake vault's current state. */
export function withdrawFor(
  h: Harness,
  s: SwapInput,
  kind: 'swap' | 'bridge-back',
  over: {
    evmNonce?: bigint;
    coinNonce?: string;
    amount?: bigint;
    dest?: string;
    colour?: string;
    erc20?: string;
    refund?: string;
    gasLimit?: bigint;
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
  } = {},
) {
  const leg = kind === 'swap' ? BID.receive : BID.pay;
  const coinNonce = over.coinNonce ?? hex32(`coin-nonce-${kind}`);
  const coin = {
    coinNonce,
    colour: over.colour ?? leg.token.midnightColour,
    amount: over.amount ?? leg.amount,
  };
  const evmNonce = over.evmNonce ?? 9n;
  const calls = fakeWithdrawCalls(
    {
      evmNonce,
      gas: {
        ...h.config.bridgeGas,
        ...(over.gasLimit ? { gasLimit: over.gasLimit } : {}),
        ...(over.maxFeePerGas ? { maxFeePerGas: over.maxFeePerGas } : {}),
        ...(over.maxPriorityFeePerGas ? { maxPriorityFeePerGas: over.maxPriorityFeePerGas } : {}),
      },
      erc20: over.erc20 ?? leg.token.sepoliaAddress,
      amount: over.amount ?? leg.amount,
      dest: over.dest ?? s.user.address,
      colour: over.colour ?? leg.token.midnightColour,
      coinNonce,
      refundCoinPk: over.refund ?? s.payload.tempCoinPk,
      tempCoinPk: s.payload.tempCoinPk,
      tempEncPk: s.payload.tempEncPk,
    },
    h.vault.version,
  );
  return { calls, coinNonce, evmNonce, tx: withdrawTx(calls, {}, coin) };
}

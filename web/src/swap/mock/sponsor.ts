// The mock sponsor: the sponsor API of the plan's Lane contracts (and L-WEB's reading of its gaps),
// served in the page as a `fetch` implementation for the REAL client (../sponsor-client.ts).
//
// It checks what the real sponsor checks, in miniature: the open-swap SponsorAction is verified for
// real (EIP-712 signature of the owner, payload hash, single-use nonce, expiry, action, network,
// swap); the offer must be live with the same two legs, both vault tokens; every later call needs the
// swap's bearer token; `/prove` and `/withdraw` accept only this swap's take or withdrawal. The
// deposit starts when the deposit address holds the exact ERC20 amount and the sweep ETH, read
// through the connected wallet's Sepolia reads (the test wallet's fake balances). Stages then advance
// one per tick.
//
// Its answers have the REAL sponsor's shapes (core swap-api.ts): the swap view in full, in a
// `{swap}` envelope on `GET /v1/swaps/:id`, `/withdraw` and `/take`, and with `resumed` on open;
// the page reads them through core's and the wallet's clients, which parse them strictly
// (web/test/sponsor-client.test.ts checks every answer against core's schemas).
//
// And the real sponsor's SEMANTICS as the P4.2-fix pass left them (plan "Lane contracts", FS on the
// fix pass; the audit's C1: the page once waited forever against the real sponsor while these specs
// passed): `withdrawals` = every attempt; `withdraw.refunds` = the refunded withdrawals up to and
// including the current one; `withdrawal = {attempts, last, retry}` says how the latest one ended
// and whether the page must rebuild; a start that fails after `/withdraw` accepted it
// (`failFirstStart`) goes back to `minted` with stage `failed` and no refund at all (the case the
// page's counters never saw); a failure can be `recoverable` (C5: a re-open revives it); and the
// sweep gas may RISE while the swap waits for its funds (`raiseSweepGas`: the page tops up).
//
// And a PARTIAL deposit as FS3's sponsor reports it (P4.2-fix3 S2; plan "Lane contracts", P4.2-fix3
// lane FS3 items 1–8; `partialSweep`): another party's request swept part of the deposit address,
// won the race and the sponsor completed it, so part of the pay amount is in the temporary wallet
// and the rest at the address. The swap is `partial` with `partial = {minted, remaining, atAddress,
// options}`; it deposits the REST by itself once the address holds it and the sweep ETH (then
// `minted`); Bridge back takes what arrived (`withdraw-params` answers `minted`), and afterwards what
// waits at the address is deposited and shows as `minted` again, for a second Bridge back.

import {
  SEPOLIA_CHAIN_ID,
  type TokenRegistry,
  payloadHash,
  recoverSponsorActionSigner,
  type SponsorActionMessage,
} from '@evm-midnight-transparent/core';
import { getAddress } from 'ethers';

import { OPEN_SWAP_ACTION, type OpenSwapPayload, type SponsorStage, type SwapView } from '../sponsor-client.js';
import type { MockChain } from './chain.js';
import { decodeMockTx, encodeMockTx, type MockTx } from './tx.js';

export interface MockScenario {
  /** Someone else takes the offer while the swap bridges in: "Swap is not available". */
  offerGoneAtTake?: boolean;
  /** Each swap's first withdrawal is refunded (a vault nonce collision, Q9 A), then retried. */
  refundFirstWithdrawal?: boolean;
  /** The sponsor refuses to open swaps, with this message. */
  refuseOpen?: string;
  /** Each swap's first `/withdraw` answers 409 stale-vault-state: the page must rebuild and prove again. */
  staleWithdrawOnce?: boolean;
  /** Each swap's first withdrawal is accepted, then its start fails in the lane (stale vault state or
   *  nonce at the head of the lane): back to `minted`, `withdrawal.retry` (P4.2-fix C1). */
  failFirstStart?: boolean;
  /** What each swap's FIRST withdrawal's Sepolia transfer looks like on the fake Sepolia (P4.2-fix4;
   *  later ones are always right): `reverted` (status 0, no log; the bridge then refunds it and the
   *  page retries), `wrong-token` (another ERC20's log), `wrong-amount` (one base unit off), `older`
   *  (mined before the user funded the swap). Default: the right transfer. */
  transferReceipt?: 'ok' | 'reverted' | 'wrong-token' | 'wrong-amount' | 'older';
  /** A withdrawal whose transfer is mined (and not reverted) waits there (the bridge's ~17 minutes of
   *  closing, held) until this is cleared: the specs check the page's Done on arrival (P4.2-fix4). */
  holdAfterTransfer?: boolean;
}

export interface EvmReader {
  ethBalance(holder: string): Promise<bigint>;
  erc20Balance(token: string, holder: string): Promise<bigint>;
}

// As the real sponsor's relay reports them: `evm-pending` while the MPC-signed transaction waits to be
// mined, `evm-broadcast` once its receipt is seen (with its hash), then finality and the attestation.
const SCRIPTS = {
  deposit: ['starting', 'started', 'mpc-signed', 'evm-pending', 'evm-broadcast', 'evm-final', 'attested', 'settled'],
  withdraw: ['started', 'mpc-signed', 'evm-pending', 'evm-broadcast', 'evm-final', 'attested', 'settled'],
  refund: ['started', 'mpc-signed', 'evm-failed', 'attested', 'refunded'],
  /** The transfer was mined but reverted (status 0): attested as failed, refunded (P4.2-fix4). */
  reverted: ['started', 'mpc-signed', 'evm-pending', 'evm-broadcast', 'evm-final', 'attested', 'refunded'],
  /** Accepted, then refused at the head of the lane: the start never lands. */
  failStart: ['queued', 'failed'],
} as const;
type ScriptName = keyof typeof SCRIPTS;
const DEPOSIT_STAGES = SCRIPTS.deposit;

export interface MockSwap {
  owner: string;
  payload: OpenSwapPayload;
  depositAddress: string;
  erc20Address: string;
  sweepGas: { gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas?: string; ethWei: string };
  token: string;
  /** Unix seconds. */
  createdAt?: number;
  /** The page's reading of the swap; the wire view is built from it (`wireView`). */
  view: SwapView;
  /** Which stage list the running leg follows, and where it is. */
  script: ScriptName | null;
  step: number;
  withdrawals: number;
  /** `/withdraw` calls refused as stale (the staleWithdrawOnce scenario). */
  stale: number;
  /** The earlier withdrawals' views (every attempt stays in `withdrawals`, as the real sponsor's). */
  earlier?: NonNullable<SwapView['withdraw']>[];
  /** Withdrawals refunded so far (every `refunds` counts up to and including its own withdrawal). */
  refunded?: number;
  /** How the latest withdrawal ended without a transfer, or null. */
  lastEnding?: 'refunded' | 'start-failed' | 'stale-vault' | null;
  /** On `failed`: a re-open revives it (C5). */
  recoverable?: boolean;
  /** A partial deposit (S2): every pay-token base unit minted to the temporary wallet so far (decimal),
   *  what Bridge backs from `partial` returned, and the pay token last read at the deposit address. */
  mintedTotal?: string;
  returned?: string;
  atAddress?: string;
  /** The running (or last) Bridge back is of a partial deposit, for `backAmount` (S2). */
  partialBack?: boolean;
  backAmount?: string;
}

export interface MockSponsorDump {
  swaps: Array<[string, MockSwap]>;
  nonces: string[];
  evmNonce: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, code: string, message: string, detail?: string) =>
  json({ error: { code, message, ...(detail ? { detail } : {}) } }, status);

const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

export interface MockSponsorOptions {
  chain: MockChain;
  registry: TokenRegistry;
  network: string;
  chainId?: number;
  depositAddressFor(coinPk: string): string;
  scenario: MockScenario;
  /** The vault's EVM account: the withdrawals' transfers come from it (network.bridge). */
  vaultEvmAddress?: string;
  now?: () => number;
}

/** A stand-in vault EVM account for a profile that names none. */
const MOCK_VAULT_EVM = '0x00000000000000000000000000000000000Fa017';

export class MockSponsor {
  readonly swaps = new Map<string, MockSwap>();
  private readonly nonces = new Set<string>();
  private evm: EvmReader | null = null;
  /** The vault EVM account's pending nonce: every withdrawal start takes the next one (one lane). */
  private evmNonce = 9;
  private readonly now: () => number;
  /** Every request the page made, for the specs (method and path only). */
  readonly requests: Array<{ method: string; path: string }> = [];

  constructor(private readonly o: MockSponsorOptions) {
    this.now = o.now ?? Date.now;
  }

  setEvmReader(reader: EvmReader | null): void {
    this.evm = reader;
  }

  /** The swaps' views, for the specs. */
  views(): SwapView[] {
    return [...this.swaps.values()].map((s) => structuredClone(s.view));
  }

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/\/+$/, '');
    this.requests.push({ method, path });
    let body: unknown;
    try {
      body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    } catch {
      return fail(400, 'bad-request', 'the body is not JSON');
    }
    const auth = new Headers(init.headers).get('authorization');

    if (method === 'GET' && path === '/v1/health') return json({ status: 'ok', network: this.o.network, mock: true });
    if (method === 'GET' && path === '/v1/auth/nonce') {
      const nonce = `0x${randomHex(32)}`;
      this.nonces.add(nonce);
      return json({ nonce, expiresAt: Math.floor(this.now() / 1000) + 600, maxTtlSeconds: 600 });
    }
    if (method === 'POST' && path === '/v1/swaps') return this.open(body);

    const m = /^\/v1\/swaps\/(0x[0-9a-f]{64})(\/prove|\/withdraw|\/withdraw-params|\/take)?$/.exec(path);
    if (!m) return fail(404, 'not-found', 'no such route');
    const swap = this.swaps.get(m[1]!);
    if (!swap) return fail(404, 'not-found', 'no such swap');
    if (auth !== `Bearer ${swap.token}`) return fail(401, 'unauthorised', 'the swap token is missing or wrong');
    if (method === 'GET' && !m[2]) return json({ swap: this.wireView(swap) });
    if (method === 'POST' && m[2] === '/prove') return this.prove(swap, body);
    if (method === 'POST' && m[2] === '/withdraw') return this.withdraw(swap, body);
    if (method === 'GET' && m[2] === '/withdraw-params') return this.withdrawParams(swap, url.searchParams.get('kind'));
    if (method === 'POST' && m[2] === '/take') return this.reportTake(swap, body);
    return fail(405, 'bad-request', 'method not allowed');
  };

  // ── POST /v1/swaps ─────────────────────────────────────────────────────

  private open(body: unknown): Response {
    const b = body as {
      swap?: string;
      payload?: OpenSwapPayload;
      auth?: { message?: SponsorActionMessage; signature?: string };
    };
    const p = b?.payload;
    const msg = b?.auth?.message;
    if (!b || typeof b.swap !== 'string' || !p || !msg || typeof b.auth?.signature !== 'string')
      return fail(400, 'bad-request', 'expected {swap, payload, auth}');
    if (msg.action !== OPEN_SWAP_ACTION) return fail(401, 'unauthorised', `signed for "${msg.action}"`);
    if (msg.network !== this.o.network) return fail(401, 'unauthorised', 'signed for another network');
    if (msg.swap !== b.swap) return fail(401, 'unauthorised', 'signed for another swap');
    let owner: string;
    try {
      owner = getAddress(p.evmAddress);
    } catch {
      return fail(400, 'bad-request', 'bad EVM address');
    }
    if (getAddress(msg.owner) !== owner) return fail(401, 'unauthorised', 'the owner is not the payload address');
    if (msg.payloadHash !== payloadHash(p)) return fail(401, 'unauthorised', 'the signature does not cover this body');
    const nowS = Math.floor(this.now() / 1000);
    if (Number(msg.expiry) <= nowS || Number(msg.expiry) > nowS + 600)
      return fail(401, 'unauthorised', 'the authorisation expired or is too far ahead');
    let signer: string;
    try {
      signer = getAddress(recoverSponsorActionSigner(msg, b.auth.signature, this.o.chainId ?? SEPOLIA_CHAIN_ID));
    } catch {
      return fail(401, 'unauthorised', 'the signature is not valid');
    }
    if (signer !== owner) return fail(401, 'unauthorised', 'the signature is not from the owner');
    if (!this.nonces.delete(msg.nonce)) return fail(401, 'unauthorised', 'unknown or used nonce');
    if (this.o.scenario.refuseOpen) return fail(503, 'unavailable', this.o.scenario.refuseOpen);

    const existing = this.swaps.get(b.swap);
    if (existing) {
      // A re-open (resume): same owner, same terms, same temporary keys; a new token.
      if (existing.owner !== owner || payloadHash(existing.payload) !== payloadHash(p))
        return fail(409, 'conflict', 'this swap exists with other terms');
      existing.token = randomHex(32);
      if (existing.view.state === 'failed' && existing.recoverable) {
        // C5: the real sponsor revives a recoverable failure on a re-open (funds-not-received: it
        // watches the deposit address again).
        existing.view.state = 'awaiting_funds';
        delete existing.view.reason;
        delete existing.view.message;
        existing.recoverable = false;
      }
      return json(this.openAnswer(existing, true));
    }

    const offer = this.o.chain.offer(p.offerId);
    if (!offer || offer.status !== 'live') return fail(409, 'offer-not-live', 'the offer is not live');
    const want = offer.wants[0];
    const give = offer.gives[0];
    if (
      offer.wants.length !== 1 ||
      offer.gives.length !== 1 ||
      !want ||
      !give ||
      want.token !== p.pay.colour ||
      want.amount.toString() !== p.pay.amount ||
      give.token !== p.receive.colour ||
      give.amount.toString() !== p.receive.amount
    )
      return fail(400, 'terms-mismatch', "the swap's legs are not the offer's");
    if (!this.o.registry.isBridgeable(p.pay.colour) || !this.o.registry.isBridgeable(p.receive.colour))
      return fail(400, 'not-bridgeable', 'a leg is not a vault token');
    const gasLimit = 65_000n;
    const maxFeePerGas = 2_500_000_000n;
    const swap: MockSwap = {
      owner,
      payload: structuredClone(p),
      depositAddress: this.o.depositAddressFor(p.tempCoinPk),
      erc20Address: this.o.registry.byColour(p.pay.colour)!.sepoliaAddress,
      sweepGas: {
        gasLimit: gasLimit.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: '500000000',
        ethWei: (gasLimit * maxFeePerGas).toString(),
      },
      token: randomHex(32),
      createdAt: Math.floor(this.now() / 1000),
      // As the real sponsor: the id without 0x, stage times in unix seconds.
      view: { swapId: b.swap.replace(/^0x/, ''), state: 'awaiting_funds' },
      script: null,
      step: 0,
      withdrawals: 0,
      stale: 0,
    };
    this.swaps.set(b.swap, swap);
    return json(this.openAnswer(swap));
  }

  private openAnswer(s: MockSwap, resumed = false) {
    return {
      swapToken: s.token,
      depositAddress: s.depositAddress,
      sweepGas: this.wireSweepGas(s),
      erc20Address: s.erc20Address,
      amount: s.payload.pay.amount,
      resumed,
      swap: this.wireView(s),
    };
  }

  private wireSweepGas(s: MockSwap) {
    return { maxPriorityFeePerGas: '500000000', ...s.sweepGas };
  }

  /** The swap as the real sponsor serves it (core `SwapViewSchema`): every field, nulls for the
   *  legs not started, stage times in unix seconds. */
  private wireView(s: MockSwap) {
    const v = s.view;
    const leg = (l: { colour: string; amount: string }) => {
      const t = this.o.registry.byColour(l.colour)!;
      return {
        colour: l.colour,
        amount: l.amount,
        symbol: t.symbol,
        erc20Address: t.sepoliaAddress,
        decimals: t.decimals,
      };
    };
    const stages = (list: SponsorStage[] | undefined) => (list ?? []).map((x) => ({ stage: x.stage, at: x.at }));
    const d = v.deposit;
    const wire = (w: NonNullable<SwapView['withdraw']>) => ({
      kind: w.colour === s.payload.pay.colour ? ('bridge-back' as const) : ('swap' as const),
      colour: w.colour ?? s.payload.receive.colour,
      amount: w.colour === s.payload.pay.colour ? (s.backAmount ?? s.payload.pay.amount) : s.payload.receive.amount,
      stage: w.stage ?? 'queued',
      stages: stages(w.stages),
      ...(w.requestId ? { requestId: w.requestId } : {}),
      ...(w.startTx ? { startTx: w.startTx } : {}),
      ...(w.sepoliaTx ? { sepoliaTx: w.sepoliaTx } : {}),
      ...(w.completeTx ? { completeTx: w.completeTx } : {}),
      // As the real sponsor: the refunded withdrawals up to and including this one.
      refunds: w.refunds ?? 0,
    });
    const withdraw = v.withdraw ? wire(v.withdraw) : null;
    const last = s.lastEnding ?? null;
    const now = Math.floor(this.now() / 1000);
    return {
      swapId: v.swapId.replace(/^0x/, ''),
      state: v.state,
      evmAddress: s.owner,
      offerId: s.payload.offerId,
      pay: leg(s.payload.pay),
      receive: leg(s.payload.receive),
      tempCoinPk: s.payload.tempCoinPk,
      depositAddress: s.depositAddress,
      erc20Address: s.erc20Address,
      amount: s.payload.pay.amount,
      sweepGas: this.wireSweepGas(s),
      deposit: d
        ? {
            stage: d.stage ?? 'starting',
            stages: stages(d.stages),
            ...(d.requestId ? { requestId: d.requestId } : {}),
            ...(d.startTx ? { startTx: d.startTx } : {}),
            ...(d.sweepTx ? { sweepTx: d.sweepTx } : {}),
            ...(d.completeTx ? { completeTx: d.completeTx } : {}),
            attempts: 1,
          }
        : null,
      ...(v.state === 'partial' ? { partial: this.partialOf(s) } : {}),
      takeTx: v.takeTx ?? null,
      withdraw,
      withdrawals: [...(s.earlier ?? []).map(wire), ...(withdraw ? [withdraw] : [])],
      withdrawal: {
        attempts: s.withdrawals,
        last,
        retry: last !== null && ['minted', 'taking', 'taken', 'partial'].includes(v.state),
      },
      ...(v.outcome ? { outcome: v.outcome } : {}),
      ...(v.reason ? { reason: v.reason } : {}),
      ...(v.message ? { message: v.message } : {}),
      ...(v.state === 'failed' ? { recoverable: !!s.recoverable } : {}),
      createdAt: s.createdAt ?? now,
      updatedAt: now,
    };
  }

  /** A partial deposit's report (FS3 item 2): what the temporary wallet holds from deposits, what is
   *  still to be deposited, what the address held at the last read, and the two options. */
  private partialOf(s: MockSwap) {
    const total = BigInt(s.mintedTotal ?? '0');
    const minted = total - BigInt(s.returned ?? '0');
    const remaining = BigInt(s.payload.pay.amount) - total;
    return {
      minted: minted.toString(),
      remaining: remaining.toString(),
      atAddress: s.atAddress ?? '0',
      options: [...(remaining > 0n ? ['wait' as const] : []), ...(minted > 0n ? ['bridge-back' as const] : [])],
    };
  }

  /** What a Bridge back withdraws now: `partial.minted` on `partial` (S2), else the pay amount. */
  private bridgeBackAmount(s: MockSwap): string {
    return s.view.state === 'partial' ? this.partialOf(s).minted : s.payload.pay.amount;
  }

  // ── /prove and /withdraw ─────────────────────────────────────────────────

  /** Why this mock transaction is not one this swap may prove or submit, or null. */
  private refusal(s: MockSwap, tx: MockTx | null, purpose: string): string | null {
    if (!tx) return 'not a transaction';
    if (tx.coinPk !== s.payload.tempCoinPk) return "not this swap's temporary wallet";
    if (purpose === 'take') {
      if (tx.kind !== 'take' || tx.offerId !== s.payload.offerId) return "not this swap's offer";
      return null;
    }
    if (tx.kind !== 'withdraw') return 'not a withdrawal';
    if (tx.dest !== s.owner) return "not to the swap's EVM address";
    const receive = tx.colour === s.payload.receive.colour && tx.amount === s.payload.receive.amount;
    const payBack = tx.colour === s.payload.pay.colour && tx.amount === this.bridgeBackAmount(s);
    return receive || payBack ? null : 'not the swap amount of a swap token';
  }

  private withdrawParams(s: MockSwap, kind: string | null): Response {
    if (kind !== 'swap' && kind !== 'bridge-back') return fail(400, 'bad-request', 'kind must be swap or bridge-back');
    // FS3 item 4: a partial deposit bridges back in `partial` only (not while the rest deposits), and
    // never swaps.
    if (
      (s.view.state === 'partial' && kind === 'swap') ||
      (s.view.state === 'depositing' && s.mintedTotal !== undefined)
    )
      return fail(409, 'wrong-state', `the swap is ${s.view.state}`);
    const leg = kind === 'swap' ? s.payload.receive : s.payload.pay;
    return json({
      kind,
      colour: leg.colour,
      amount: kind === 'swap' ? leg.amount : this.bridgeBackAmount(s),
      erc20Address: this.o.registry.byColour(leg.colour)!.sepoliaAddress,
      dest: s.owner,
      refundRecipient: s.payload.tempCoinPk,
      gas: { gasLimit: '100000', maxFeePerGas: '10000000000', maxPriorityFeePerGas: '1000000000', keyVersion: '1' },
      evmNonce: String(this.evmNonce),
      vaultAddress: '77'.repeat(32),
    });
  }

  private prove(s: MockSwap, body: unknown): Response {
    const b = body as {
      purpose?: string;
      tx?: string;
      coinNonce?: string;
      evmNonce?: string;
      walletOutputs?: Array<{ nonce?: string; colour?: string; value?: string }>;
    };
    if (!b || (b.purpose !== 'take' && b.purpose !== 'withdraw') || typeof b.tx !== 'string')
      return fail(400, 'bad-request', 'expected {purpose, tx}');
    const tx = decodeMockTx(b.tx);
    const why = this.refusal(s, tx, b.purpose);
    if (why) return fail(422, 'refused', why);
    // P4.2-fix2 R1, in miniature: every coin the transaction pays to the wallet must be disclosed
    // (the real sponsor recomputes each commitment); a take always pays one, so it must disclose.
    const disclosed = new Set((b.walletOutputs ?? []).map((o) => `${o.nonce}:${o.colour}:${o.value}`));
    if (
      (b.purpose === 'take' && b.walletOutputs === undefined) ||
      (tx!.outputs ?? []).some((o) => !disclosed.has(`${o.nonce}:${o.colour}:${o.value}`))
    )
      return fail(
        422,
        'invalid-tx',
        'an output is neither the vault coin nor a disclosed wallet coin',
        'undisclosed-output',
      );
    if (b.purpose === 'withdraw') {
      if (b.coinNonce !== tx!.coinNonce || b.evmNonce !== tx!.evmNonce)
        return fail(422, 'refused', "the hints are not the transaction's");
      if (b.evmNonce !== String(this.evmNonce)) return fail(409, 'stale-evm-nonce', 'the vault account moved on');
    }
    if (b.purpose === 'take' && s.view.state === 'minted') s.view.state = 'taking';
    return json({ tx: encodeMockTx({ ...tx!, proven: true }) });
  }

  private reportTake(s: MockSwap, body: unknown): Response {
    const b = body as { outcome?: string; takeTx?: string };
    if (b?.outcome === 'taken' && typeof b.takeTx === 'string' && /^[0-9a-f]{64}$/.test(b.takeTx)) {
      if (['minted', 'taking', 'taken'].includes(s.view.state)) {
        s.view.state = 'taken';
        s.view.takeTx = b.takeTx;
      }
    } else if (b?.outcome === 'not-available') {
      if (s.view.state === 'taking') s.view.state = 'minted';
    } else return fail(400, 'bad-request', 'expected {outcome}');
    return json({ swap: this.wireView(s) });
  }

  private withdraw(s: MockSwap, body: unknown): Response {
    const b = body as { tx?: string };
    const tx = typeof b?.tx === 'string' ? decodeMockTx(b.tx) : null;
    if (!tx?.proven || !tx.bound) return fail(400, 'bad-request', 'expected a proven, bound withdrawal');
    const why = this.refusal(s, tx, 'withdraw');
    if (why) return fail(422, 'refused', why);
    const partialBack = s.view.state === 'partial' && tx.colour === s.payload.pay.colour;
    if (!['minted', 'taking', 'taken'].includes(s.view.state) && !partialBack)
      return fail(409, 'wrong-state', `the swap is ${s.view.state}`);
    if (this.o.scenario.staleWithdrawOnce && s.stale === 0) {
      s.stale++;
      return fail(409, 'stale-vault-state', 'the vault state moved on: rebuild the withdrawal');
    }
    if (tx.evmNonce !== String(this.evmNonce)) return fail(409, 'stale-evm-nonce', 'the vault account moved on');
    const back = tx.colour === s.payload.pay.colour;
    s.partialBack = partialBack;
    if (back) s.backAmount = tx.amount!;
    const refund = !!this.o.scenario.refundFirstWithdrawal && s.withdrawals === 0;
    const failStart = !!this.o.scenario.failFirstStart && s.withdrawals === 0;
    if ((this.o.chain.balances(s.payload.tempCoinPk).get(tx.colour!) ?? 0n) < BigInt(tx.amount!))
      return fail(409, 'conflict', 'the temporary wallet does not hold that coin');
    if (!failStart) {
      // The start lands: the coin is spent into the vault (the wallet's next sync sees it spent). A
      // start that fails in the lane never lands: its coin is never spent, and stays booked in the
      // wallet until the page releases the draft (P4.2-fix2 R3, F-B24).
      this.evmNonce++;
      this.o.chain.burn(s.payload.tempCoinPk, tx.colour!, BigInt(tx.amount!));
      this.o.chain.markSpent(tx.draft);
    }
    const reverted = this.o.scenario.transferReceipt === 'reverted' && s.withdrawals === 0;
    s.withdrawals++;
    s.lastEnding = null;
    if (s.view.withdraw) (s.earlier ??= []).push(structuredClone(s.view.withdraw));
    s.script = failStart ? 'failStart' : refund ? 'refund' : reverted ? 'reverted' : 'withdraw';
    s.step = 0;
    s.view.state = back ? 'bridging_back' : 'withdrawing';
    s.view.withdraw = failStart
      ? { colour: tx.colour!, stage: 'queued', stages: [this.stage('queued')], refunds: s.refunded ?? 0 }
      : {
          colour: tx.colour!,
          requestId: this.o.chain.newHash('withdraw-request'),
          startTx: `00${this.o.chain.newHash('start-withdraw')}`,
          stage: 'started',
          stages: [this.stage('started')],
          refunds: s.refunded ?? 0,
        };
    return json({ swap: this.wireView(s) });
  }

  /** The live base fee outgrew the sweep gas of every swap still waiting for its funds: raise it
   *  (never lower it), as the real sponsor does (FS C2); the page tops the deposit address up. */
  raiseSweepGas(): void {
    for (const s of this.swaps.values()) {
      if (s.view.state !== 'awaiting_funds') continue;
      const maxFeePerGas = BigInt(s.sweepGas.maxFeePerGas) * 2n;
      s.sweepGas = {
        ...s.sweepGas,
        maxFeePerGas: maxFeePerGas.toString(),
        ethWei: (BigInt(s.sweepGas.gasLimit) * maxFeePerGas).toString(),
      };
    }
  }

  /** Another party's request swept `units` of the pay token off the deposit address of every swap
   *  waiting for or running its deposit, won the sweep race, and the sponsor completed it (S2, the
   *  audit's F-A32): the units are minted to the temporary wallet, the sponsor's own sweep is
   *  abandoned, and the swap is `partial`. The caller moves the units (and the sweep ETH the other
   *  sweep used) off the deposit address in its fake Sepolia. */
  partialSweep(units: bigint): void {
    for (const s of this.swaps.values()) {
      if (s.view.state !== 'awaiting_funds' && s.view.state !== 'depositing') continue;
      this.o.chain.mint(s.payload.tempCoinPk, s.payload.pay.colour, units);
      s.mintedTotal = (BigInt(s.mintedTotal ?? '0') + units).toString();
      s.atAddress = (BigInt(s.payload.pay.amount) - BigInt(s.mintedTotal)).toString();
      s.script = null;
      s.step = 0;
      const v = s.view;
      v.state = 'partial';
      const stages = [...(v.deposit?.stages ?? [])];
      if (v.deposit?.requestId) stages.push(this.stage('abandoned'));
      stages.push(this.stage('completed-foreign'), this.stage('partial'));
      v.deposit = { stage: 'partial', stages };
    }
  }

  /** Fail every swap still waiting for its funds (the real sponsor's `funds-not-received` after its
   *  funding window), recoverable or not (C5). */
  failAwaitingFunds(recoverable: boolean): void {
    for (const s of this.swaps.values()) {
      if (s.view.state !== 'awaiting_funds') continue;
      s.view.state = 'failed';
      s.view.reason = 'funds-not-received';
      s.view.message = 'The funds did not reach the deposit address in time.';
      s.recoverable = recoverable;
    }
  }

  /** Fail every swap waiting for or running its deposit the way a failed sweep does (the real
   *  sponsor's `deposit-attempts`: the tokens stay at the deposit address), recoverable or not: a
   *  re-open re-arms it, and it waits for the funds (the sweep ETH) again (P4.2-fix2 R7). */
  failDeposit(recoverable: boolean): void {
    for (const s of this.swaps.values()) {
      if (s.view.state !== 'awaiting_funds' && s.view.state !== 'depositing') continue;
      s.view.state = 'failed';
      s.view.reason = 'deposit-attempts';
      s.view.message = 'The deposit sweep did not execute.';
      s.recoverable = recoverable;
      s.script = null;
      s.step = 0;
      delete s.view.deposit;
    }
  }

  private stage(stage: string): SponsorStage {
    return { stage, at: Math.floor(this.now() / 1000) };
  }

  /** The withdrawal's ERC20 transfer from the vault's EVM account to the swap's owner, mined on the
   *  fake Sepolia (the receipt the page reads to show Done on arrival, P4.2-fix4); each swap's first
   *  one as `transferReceipt` says. Returns its hash, the view's `sepoliaTx`. */
  private mineTransfer(s: MockSwap, w: NonNullable<SwapView['withdraw']>): string {
    const back = w.colour === s.payload.pay.colour;
    const amount = BigInt(back ? (s.backAmount ?? s.payload.pay.amount) : s.payload.receive.amount);
    const token = this.o.registry.byColour(back ? s.payload.pay.colour : s.payload.receive.colour)!.sepoliaAddress;
    const kind = s.withdrawals === 1 ? (this.o.scenario.transferReceipt ?? 'ok') : 'ok';
    const other = this.o.registry.tokens.find(
      (t) => t.sepoliaAddress && t.sepoliaAddress.toLowerCase() !== token.toLowerCase(),
    )!.sepoliaAddress;
    return this.o.chain.mineSepoliaTransfer({
      token: kind === 'wrong-token' ? other : token,
      from: this.o.vaultEvmAddress || MOCK_VAULT_EVM,
      to: s.owner,
      amount: (kind === 'wrong-amount' ? (amount > 1n ? amount - 1n : amount + 1n) : amount).toString(),
      status: kind === 'reverted' ? 0 : 1,
      ...(kind === 'older' ? { blockNumber: 4_000_000 } : {}),
    });
  }

  // ── persistence ───────────────────────────────────────────────────────

  dump(): MockSponsorDump {
    return {
      swaps: [...this.swaps].map(([id, s]) => [id, structuredClone(s)]),
      nonces: [...this.nonces],
      evmNonce: this.evmNonce,
    };
  }

  restore(d: MockSponsorDump): void {
    this.swaps.clear();
    for (const [id, s] of d.swaps) this.swaps.set(id, structuredClone(s));
    this.nonces.clear();
    for (const n of d.nonces) this.nonces.add(n);
    this.evmNonce = d.evmNonce ?? this.evmNonce;
  }

  // ── the clock ─────────────────────────────────────────────────────────

  /** Advance every swap by one step. */
  async tick(): Promise<void> {
    for (const s of this.swaps.values()) await this.advance(s);
  }

  private async advance(s: MockSwap): Promise<void> {
    const v = s.view;
    const chain = this.o.chain;
    if (v.state === 'partial') {
      // FS3 item 3: the rest is deposited by the sponsor itself once the address holds it and the
      // sweep ETH.
      if (!this.evm) return;
      try {
        const [token, eth] = await Promise.all([
          this.evm.erc20Balance(s.erc20Address, s.depositAddress),
          this.evm.ethBalance(s.depositAddress),
        ]);
        s.atAddress = token.toString();
        const rest = BigInt(s.payload.pay.amount) - BigInt(s.mintedTotal ?? '0');
        if (rest > 0n && token >= rest && eth >= BigInt(s.sweepGas.ethWei)) {
          v.state = 'depositing';
          s.script = 'deposit';
          s.step = 0;
          v.deposit = {
            ...v.deposit,
            stage: DEPOSIT_STAGES[0],
            stages: [...(v.deposit?.stages ?? []), this.stage(DEPOSIT_STAGES[0]!)],
          };
        }
      } catch {
        /* the reads failed: try again next tick */
      }
      return;
    }
    if (v.state === 'awaiting_funds') {
      if (!this.evm) return;
      try {
        const [token, eth] = await Promise.all([
          this.evm.erc20Balance(s.erc20Address, s.depositAddress),
          this.evm.ethBalance(s.depositAddress),
        ]);
        if (token >= BigInt(s.payload.pay.amount) && eth >= BigInt(s.sweepGas.ethWei)) {
          v.state = 'depositing';
          s.script = 'deposit';
          s.step = 0;
          v.deposit = { stage: DEPOSIT_STAGES[0], stages: [this.stage(DEPOSIT_STAGES[0]!)] };
        }
      } catch {
        /* the reads failed: try again next tick */
      }
      return;
    }
    if (v.state === 'depositing' && v.deposit) {
      const next = DEPOSIT_STAGES[++s.step];
      if (next === undefined) {
        // The whole pay amount, or after a partial deposit (S2) the rest of it.
        const total = BigInt(s.mintedTotal ?? '0');
        chain.mint(s.payload.tempCoinPk, s.payload.pay.colour, BigInt(s.payload.pay.amount) - total);
        if (s.mintedTotal !== undefined && s.returned !== undefined) {
          // After a Bridge back of what arrived first: the rest shows as `minted`, to bridge back (FS3 5).
          s.mintedTotal = s.payload.pay.amount;
          v.state = 'partial';
          return;
        }
        delete s.mintedTotal;
        v.state = 'minted';
        if (this.o.scenario.offerGoneAtTake) chain.consume(s.payload.offerId);
        return;
      }
      v.deposit.stage = next;
      v.deposit.stages = [...(v.deposit.stages ?? []), this.stage(next)];
      if (next === 'started') {
        v.deposit.requestId = chain.newHash('deposit-request');
        v.deposit.startTx = `00${chain.newHash('start-deposit')}`;
      }
      if (next === 'evm-broadcast') v.deposit.sweepTx = `0x${chain.newHash('sweep')}`;
      if (next === 'settled') v.deposit.completeTx = `00${chain.newHash('complete-deposit')}`;
      return;
    }
    if ((v.state === 'minted' || v.state === 'taking') && !v.takeTx) {
      const bal = chain.balances(s.payload.tempCoinPk).get(s.payload.receive.colour) ?? 0n;
      const offer = chain.offer(s.payload.offerId);
      if (bal >= BigInt(s.payload.receive.amount) && offer?.status === 'consumed') {
        v.state = 'taken';
        v.takeTx = chain.lastTake(s.payload.tempCoinPk) ?? undefined;
      }
      return;
    }
    if ((v.state === 'withdrawing' || v.state === 'bridging_back') && v.withdraw) {
      const next = s.script ? SCRIPTS[s.script][++s.step] : undefined;
      const w = v.withdraw;
      if (next === undefined) {
        if (s.script === 'refund' || s.script === 'reverted' || s.script === 'failStart') {
          // Refunded to the temporary wallet (a NEW coin: the transfer never happened, or it was
          // mined and reverted), or the start never landed (the coin was never spent, nothing to
          // mint): back to `minted` with `withdrawal.retry`; the app rebuilds and retries. A refund
          // counts itself in `refunds`; a failed start is no refund.
          if (s.script !== 'failStart')
            chain.mint(
              s.payload.tempCoinPk,
              w.colour!,
              BigInt(
                w.colour === s.payload.pay.colour ? (s.backAmount ?? s.payload.pay.amount) : s.payload.receive.amount,
              ),
            );
          if (s.script !== 'failStart') {
            s.refunded = (s.refunded ?? 0) + 1;
            w.refunds = s.refunded;
          }
          s.lastEnding = s.script === 'failStart' ? 'start-failed' : 'refunded';
          s.script = null;
          // A Bridge back of a partial deposit goes back to `partial` (FS3 item 4).
          v.state = s.partialBack ? 'partial' : 'minted';
          return;
        }
        if (s.partialBack) {
          // FS3 item 5: what came back is counted; what waits at the deposit address is deposited
          // next (then bridged back too); with nothing left to recover the swap is done.
          s.returned = (BigInt(s.returned ?? '0') + BigInt(s.backAmount ?? '0')).toString();
          s.partialBack = false;
          const left = BigInt(s.payload.pay.amount) - BigInt(s.mintedTotal ?? '0');
          if (left > 0n && BigInt(s.atAddress ?? '0') > 0n) {
            v.state = 'partial';
            return;
          }
        }
        v.outcome = v.state === 'bridging_back' ? 'bridged-back' : 'swapped';
        v.state = 'done';
        return;
      }
      // P4.2-fix4: the transfer is mined; the bridge closes the request later. Held there while the
      // scenario says so (the page shows Done on arrival meanwhile).
      if (w.stage === 'evm-broadcast' && s.script === 'withdraw' && this.o.scenario.holdAfterTransfer) {
        s.step--;
        return;
      }
      w.stage = next;
      w.stages = [...(w.stages ?? []), this.stage(next)];
      if (next === 'evm-broadcast') w.sepoliaTx = this.mineTransfer(s, w);
      if (next === 'settled' || next === 'refunded') w.completeTx = `00${chain.newHash('complete-withdraw')}`;
    }
  }
}

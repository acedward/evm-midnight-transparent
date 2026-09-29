// One swap, driven from this tab: the side effects around the pure decisions in ./flow.ts.
//
//   begin   the offer is still live → "start swap" signed TWICE through the wallet module (the seed,
//           and whether the wallet signs deterministically; if not, the user must confirm that the
//           swap cannot be recovered once the tab closes) → the temporary wallet → the sponsor's
//           open-swap SponsorAction (a third signature) → checks on the answer → the swap record;
//   fund    the two Sepolia transactions from the connected wallet: the sized sweep ETH, then the
//           exact ERC20 amount, both to the deposit address (never more than is missing there);
//   loop    the sponsor's state, every `pollMs`: bridge-in progress; once minted, the take (offer
//           still live → build → prove at the sponsor → still live → batcher) or "Swap is not
//           available"; then the withdrawal of the received token (or, after Bridge back, of the
//           paid one) → prove → the sponsor's withdrawal lane; a refund rebuilds it (Q9 A);
//   resume  "start swap" signed ONCE: the re-derived coin key must equal the record's; then the swap
//           is re-opened with the sponsor for a new token, and the loop continues from its state.
//
// Secrets stay in this object only: the seed (the temporary wallet's key) and the sponsor's swap
// token. Neither is put in the snapshot, the record, a log or an error message.

import {
  type NetworkProfile,
  type SwapOffer,
  type TokenRegistry,
  newSwapSalt,
  recoverStartSwapSigner,
  startSwapTypedData,
  swapSeedFromSignature,
} from '@evm-midnight-transparent/core';
import { getAddress } from 'ethers';

import { EvmError, type EvmPort, transferData } from './evm.js';
import { MAX_AUTO_RETRIES, afterMint, applyView, nextAction } from './flow.js';
import { lastsLongEnough } from './offers.js';
import type { SwapBackends, TempWallet, TypedDataSigner } from './ports.js';
import { SWAP_RECORD_VERSION, type SwapRecord, isFinished } from './record-shape.js';
import {
  type OpenSwapPayload,
  type OpenSwapResponse,
  SponsorError,
  type SwapView,
  openSwapMessage,
  signOpenSwap,
} from './sponsor-client.js';

/** The most sweep ETH the page will send (the sponsor sizes it; G-BRIDGE: 0.0001625 ETH). */
export const MAX_SWEEP_WEI = 3n * 10n ** 15n;

export type SessionStatus =
  | { kind: 'signing'; prompt: 'start-1' | 'start-2' | 'sponsor' | 'resume' }
  /** The two "start swap" signatures differed: waiting for the user to accept or cancel. */
  | { kind: 'confirm-nondeterministic' }
  | { kind: 'opening' }
  /** Waiting for the user's "Send funds"; `sending` while a wallet prompt is open. */
  | { kind: 'fund'; sending: 'checking' | 'eth' | 'token' | null }
  | { kind: 'working'; what: string }
  /** The offer was gone at take time: waiting for Bridge back. */
  | { kind: 'unavailable' }
  | { kind: 'done' }
  | { kind: 'error'; message: string; canRetry: boolean }
  | { kind: 'stopped'; message: string };

export interface SessionSnapshot {
  swapId: string;
  offer: SwapOffer | null;
  record: SwapRecord | null;
  status: SessionStatus;
  /** Null until the two signatures were compared. */
  deterministic: boolean | null;
  temp: { coinPk: string; encPk: string; shieldedAddress: string } | null;
  /** The sponsor's latest view (public). */
  view: SwapView | null;
  /** A passing message: a refund being retried, a failed transfer. */
  notice: string | null;
}

export interface SessionDeps {
  backends: SwapBackends;
  network: NetworkProfile;
  registry: TokenRegistry;
  signer: TypedDataSigner;
  evm: EvmPort;
  save(record: SwapRecord): void;
  /** Why the connected wallet may not fund a swap here (mock mode with a real wallet), or null. */
  fundingRefusal?: () => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newSalt?: () => string;
}

export class SessionError extends Error {
  override name = 'SessionError';
}

const leg = (l: SwapOffer['pay']) => ({
  colour: l.token.midnightColour,
  symbol: l.token.symbol,
  midnightName: l.token.midnightName,
  decimals: l.token.decimals,
  amount: l.amount.toString(),
});

/** The user-facing text of an error, never a secret (errors here carry no key material). */
function describe(e: unknown): string {
  if (e instanceof EvmError || e instanceof SponsorError || e instanceof SessionError) return e.message;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m.slice(0, 300) : 'Something went wrong.';
}

export class SwapSession {
  private snap: SessionSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly deps: Required<Omit<SessionDeps, 'fundingRefusal'>> & Pick<SessionDeps, 'fundingRefusal'>;
  /** SECRET: the temporary wallet's key. */
  private seed: string | null = null;
  /** SECRET: the sponsor's bearer token for this swap. */
  private token: string | null = null;
  private wallet: TempWallet | null = null;
  private looping = false;
  private closed = false;
  private decide: ((ok: boolean) => void) | null = null;
  /** One more automatic withdrawal after MAX_AUTO_RETRIES refunds, approved by the user. */
  private retryApproved = false;

  private constructor(swapId: string, offer: SwapOffer | null, record: SwapRecord | null, deps: SessionDeps) {
    this.deps = {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      newSalt: () => newSwapSalt(),
      ...deps,
    };
    this.snap = {
      swapId,
      offer,
      record,
      status: { kind: 'signing', prompt: record ? 'resume' : 'start-1' },
      deterministic: record?.deterministic ?? null,
      temp: record?.temp ?? null,
      view: null,
      notice: null,
    };
  }

  /** Start a new swap on `offer`. */
  static begin(offer: SwapOffer, deps: SessionDeps): SwapSession {
    const salt = (deps.newSalt ?? (() => newSwapSalt()))().toLowerCase();
    const s = new SwapSession(salt, offer, null, deps);
    void s.start();
    return s;
  }

  /** Resume a swap from its record (sign the start message again). */
  static resume(record: SwapRecord, deps: SessionDeps): SwapSession {
    const s = new SwapSession(record.swapId, null, record, deps);
    void s.resumeFlow();
    return s;
  }

  // ── the React side ───────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snap;

  get isClosed(): boolean {
    return this.closed;
  }

  private set(patch: Partial<SessionSnapshot>): void {
    if (this.closed && patch.status?.kind !== 'stopped') return;
    this.snap = { ...this.snap, ...patch };
    for (const l of [...this.listeners]) l();
  }

  private status(status: SessionStatus): void {
    this.set({ status });
  }

  private saveRecord(record: SwapRecord): void {
    const before = this.snap.record;
    const same = before && JSON.stringify({ ...before, updatedAt: 0 }) === JSON.stringify({ ...record, updatedAt: 0 });
    if (!same) this.deps.save(record);
    this.set({ record: same ? before : record });
  }

  private get record(): SwapRecord {
    const r = this.snap.record;
    if (!r) throw new SessionError('the swap has no record yet');
    return r;
  }

  private fail(e: unknown, canRetry: boolean): void {
    this.status({ kind: 'error', message: describe(e), canRetry });
  }

  // ── start ───────────────────────────────────────────────────────────────

  private async start(): Promise<void> {
    const { backends, signer, network } = this.deps;
    const offer = this.snap.offer!;
    try {
      if (!backends.sponsor) throw new SessionError('No sponsor service is configured, so a swap cannot start.');
      const status = await backends.kernel.offerStatus(offer.offerId);
      if (status !== 'live') throw new SessionError('This offer is no longer live. Nothing was signed or sent.');
      if (!lastsLongEnough(offer, this.deps.now()))
        throw new SessionError('This offer expires before a swap could finish. Nothing was signed or sent.');

      let prompts = 0;
      const counting: TypedDataSigner = {
        address: signer.address,
        signTypedData: (td) => {
          this.status({ kind: 'signing', prompt: prompts++ === 0 ? 'start-1' : 'start-2' });
          return signer.signTypedData(td);
        },
      };
      const { seed, deterministic } = await backends.wallet.deriveSwapSeed(counting, this.snap.swapId);
      this.seed = seed;
      const wallet = await backends.wallet.createTempWallet(seed);
      this.wallet = wallet;
      void wallet.sync().catch(() => undefined); // warm up while the user funds the swap
      this.set({
        deterministic,
        temp: { coinPk: wallet.coinPk, encPk: wallet.encPk, shieldedAddress: wallet.shieldedAddress },
      });
      if (!deterministic) {
        this.status({ kind: 'confirm-nondeterministic' });
        const ok = await new Promise<boolean>((resolve) => (this.decide = resolve));
        this.decide = null;
        if (!ok) {
          await this.close('You cancelled the swap. Nothing was sent.');
          return;
        }
      }
      if (this.closed) return;
      const opened = await this.open(null);
      const now = this.deps.now();
      let record: SwapRecord = {
        v: SWAP_RECORD_VERSION,
        swapId: this.snap.swapId,
        derivation: 1,
        network: network.name,
        vault: network.bridge.vaultAddress,
        evmAddress: getAddress(signer.address),
        deterministic,
        offer: { offerId: offer.offerId, pay: leg(offer.pay), receive: leg(offer.receive), expiresAt: offer.expiresAt },
        temp: { coinPk: wallet.coinPk, encPk: wallet.encPk, shieldedAddress: wallet.shieldedAddress },
        deposit: {
          address: getAddress(opened.depositAddress),
          erc20Address: getAddress(opened.erc20Address),
          amount: opened.amount,
          sweepGas: opened.sweepGas,
        },
        funding: {},
        bridgeIn: {},
        take: {},
        choice: 'swap',
        bridgeOut: {},
        phase: 'funding',
        createdAt: now,
        updatedAt: now,
      };
      if (opened.swap) record = applyView(record, opened.swap, now);
      this.saveRecord(record);
      void this.loop();
    } catch (e) {
      this.fail(e, false);
    }
  }

  /** The user's answer to "your wallet signs differently each time". */
  confirmNonDeterministic(ok: boolean): void {
    this.decide?.(ok);
  }

  /** Open (or, for a resume, re-open) the swap with the sponsor: one SponsorAction signature. */
  private async open(existing: SwapRecord | null): Promise<OpenSwapResponse> {
    const { backends, signer, network, registry } = this.deps;
    const sponsor = backends.sponsor;
    if (!sponsor) throw new SessionError('No sponsor service is configured.');
    const wallet = this.wallet!;
    const pay = existing ? existing.offer.pay : leg(this.snap.offer!.pay);
    const receive = existing ? existing.offer.receive : leg(this.snap.offer!.receive);
    const payload: OpenSwapPayload = {
      offerId: existing ? existing.offer.offerId : this.snap.offer!.offerId,
      evmAddress: getAddress(signer.address),
      pay: { colour: pay.colour, amount: pay.amount },
      receive: { colour: receive.colour, amount: receive.amount },
      tempCoinPk: wallet.coinPk,
      tempEncPk: wallet.encPk,
    };
    this.status({ kind: 'signing', prompt: 'sponsor' });
    const nonce = await sponsor.nonce();
    const expiry = Math.floor(this.deps.now() / 1000) + Math.min(300, nonce.maxTtlSeconds);
    const message = openSwapMessage({
      network: network.name,
      swapId: this.snap.swapId,
      payload,
      nonce: nonce.nonce,
      expiry,
    });
    const auth = await signOpenSwap(signer, message, network.evm.chainId);
    this.status({ kind: 'opening' });
    const res = await sponsor.openSwap({ swap: this.snap.swapId, payload, auth });

    // Never fund an address this page did not compute, a token it did not choose, or another amount.
    const mine = getAddress(backends.wallet.depositAddressFor(wallet.coinPk));
    if (getAddress(res.depositAddress) !== mine || (existing && getAddress(existing.deposit.address) !== mine))
      throw new SessionError(
        "The sponsor's deposit address does not match the one this page computed. Nothing was sent.",
      );
    const token = registry.byColour(pay.colour);
    if (!token || getAddress(res.erc20Address) !== getAddress(token.sepoliaAddress))
      throw new SessionError('The sponsor named another token contract than the one this swap pays. Nothing was sent.');
    if (res.amount !== pay.amount)
      throw new SessionError('The sponsor asked for another amount than the offer wants. Nothing was sent.');
    const g = res.sweepGas;
    if (BigInt(g.ethWei) !== BigInt(g.gasLimit) * BigInt(g.maxFeePerGas) || BigInt(g.ethWei) > MAX_SWEEP_WEI)
      throw new SessionError('The sweep gas the sponsor asks for is not one this page will send. Nothing was sent.');
    this.token = res.swapToken;
    return res;
  }

  // ── resume ──────────────────────────────────────────────────────────────

  private async resumeFlow(): Promise<void> {
    const { backends, signer } = this.deps;
    const record = this.record;
    try {
      if (getAddress(signer.address) !== getAddress(record.evmAddress))
        throw new SessionError('Connect the wallet that started this swap to resume it.');
      const params = { network: record.network, vault: record.vault, salt: record.swapId };
      this.status({ kind: 'signing', prompt: 'resume' });
      const signature = await signer.signTypedData(startSwapTypedData(params));
      if (recoverStartSwapSigner(params, signature) !== getAddress(record.evmAddress))
        throw new SessionError('The signature is not from the wallet that started this swap.');
      const wallet = await backends.wallet.createTempWallet(swapSeedFromSignature(signature));
      if (wallet.coinPk !== record.temp.coinPk) {
        await wallet.close();
        throw new SessionError(
          `Your wallet signed the start message differently this time, so this page cannot re-create the swap's Midnight wallet.${
            record.deterministic ? '' : ' This swap was marked as not recoverable when it started.'
          }`,
        );
      }
      this.seed = swapSeedFromSignature(signature);
      this.wallet = wallet;
      void wallet.sync().catch(() => undefined);
      if (isFinished(record)) {
        this.status(
          record.phase === 'done'
            ? { kind: 'done' }
            : { kind: 'error', message: record.error ?? 'This swap failed.', canRetry: false },
        );
        return;
      }
      const opened = await this.open(record);
      if (opened.swap) this.saveRecord(applyView(this.record, opened.swap, this.deps.now()));
      void this.loop();
    } catch (e) {
      this.fail(e, false);
    }
  }

  // ── funding ─────────────────────────────────────────────────────────────

  /** "Send funds": the sweep ETH first (so the gas is there when the sponsor starts the deposit),
   *  then the exact token amount; each only if the deposit address still lacks it. */
  async sendFunds(): Promise<void> {
    if (this.snap.status.kind !== 'fund' || this.snap.status.sending !== null) return;
    const { evm } = this.deps;
    try {
      const refusal = this.deps.fundingRefusal?.();
      if (refusal) throw new SessionError(refusal);
      this.status({ kind: 'fund', sending: 'checking' });
      const r = this.record;
      const dep = r.deposit;
      const amount = BigInt(dep.amount);
      const ethWei = BigInt(dep.sweepGas.ethWei);
      const [ethThere, tokenThere, myEth, myToken] = await Promise.all([
        evm.ethBalance(dep.address),
        evm.erc20Balance(dep.erc20Address, dep.address),
        evm.ethBalance(evm.address),
        evm.erc20Balance(dep.erc20Address, evm.address),
      ]);
      const pendingEth = r.funding.eth?.status === 'sent';
      const pendingToken = r.funding.token?.status === 'sent';
      const needEth = !pendingEth && ethThere < ethWei ? ethWei - ethThere : 0n;
      const needToken = !pendingToken && tokenThere < amount ? amount - tokenThere : 0n;
      if (needToken > myToken)
        throw new SessionError(
          `Your wallet holds less ${r.offer.pay.symbol} on Sepolia than this swap pays. Nothing was sent.`,
        );
      if (needEth > myEth)
        throw new SessionError('Your wallet holds less Sepolia ETH than the sweep gas. Nothing was sent.');
      if (needEth > 0n) {
        this.status({ kind: 'fund', sending: 'eth' });
        const hash = await evm.sendTransaction({ to: dep.address, value: needEth }, 'the sweep gas transfer');
        this.saveRecord({
          ...this.record,
          funding: { ...this.record.funding, eth: { hash, status: 'sent' } },
          updatedAt: this.deps.now(),
        });
      }
      if (needToken > 0n) {
        this.status({ kind: 'fund', sending: 'token' });
        const hash = await evm.sendTransaction(
          { to: dep.erc20Address, data: transferData(dep.address, needToken) },
          `the ${r.offer.pay.symbol} transfer`,
        );
        this.saveRecord({
          ...this.record,
          funding: { ...this.record.funding, token: { hash, status: 'sent' } },
          updatedAt: this.deps.now(),
        });
      }
      this.status({ kind: 'working', what: 'Waiting for your funds to reach the deposit address' });
      void this.loop();
    } catch (e) {
      this.set({ status: { kind: 'fund', sending: null }, notice: describe(e) });
    }
  }

  /** Every funding transaction sent and not failed, or the deposit address already funded. */
  private fundingSent(r: SwapRecord): boolean {
    const ok = (t: SwapRecord['funding']['eth']) => t !== undefined && t.status !== 'failed';
    return ok(r.funding.eth) && ok(r.funding.token);
  }

  private async checkReceipts(): Promise<void> {
    const r = this.record;
    const funding = { ...r.funding };
    let changed = false;
    for (const k of ['eth', 'token'] as const) {
      const t = funding[k];
      if (t?.status !== 'sent') continue;
      const outcome = await this.deps.evm.receipt(t.hash).catch(() => null);
      if (outcome === null) continue;
      funding[k] = { hash: t.hash, status: outcome === 'success' ? 'confirmed' : 'failed' };
      changed = true;
      if (outcome !== 'success')
        this.set({
          notice: `Your ${k === 'eth' ? 'sweep gas' : r.offer.pay.symbol} transfer failed on Sepolia. Send the funds again.`,
        });
    }
    if (changed) this.saveRecord({ ...r, funding, updatedAt: this.deps.now() });
  }

  // ── the loop ────────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    if (this.looping || this.closed) return;
    this.looping = true;
    const { backends } = this.deps;
    let misses = 0;
    try {
      while (!this.closed) {
        let view: SwapView;
        try {
          view = await backends.sponsor!.swap(this.snap.swapId, this.token!);
          misses = 0;
        } catch (e) {
          if (e instanceof SponsorError && (e.status === 401 || e.status === 404)) {
            this.fail(
              new SessionError('The sponsor no longer recognises this session. Resume the swap to sign in again.'),
              false,
            );
            return;
          }
          if (++misses >= 10) {
            this.fail(e, true);
            return;
          }
          this.set({ notice: 'The sponsor did not answer; trying again.' });
          await this.deps.sleep(backends.pollMs * 2);
          continue;
        }
        const before = this.record;
        const record = applyView(before, view, this.deps.now());
        const refunds = record.bridgeOut.refunds ?? 0;
        if (refunds > (before.bridgeOut.refunds ?? 0))
          this.set({
            notice: `The withdrawal was refunded to the temporary wallet (another withdrawal used the vault's Sepolia nonce). Retrying${
              refunds < MAX_AUTO_RETRIES ? ` (attempt ${refunds + 1})` : ''
            }.`,
          });
        this.saveRecord(record);
        this.set({ view });
        // A funding transfer still pending: read its receipt, whatever the sponsor's state.
        if (record.funding.eth?.status === 'sent' || record.funding.token?.status === 'sent')
          await this.checkReceipts();
        const act = nextAction(this.record, view);
        if (act === 'finished') {
          this.status(
            record.phase === 'done'
              ? { kind: 'done' }
              : { kind: 'error', message: record.error ?? 'The swap failed.', canRetry: false },
          );
          await this.wallet?.close().catch(() => undefined);
          return;
        }
        if (act === 'fund') {
          if (this.fundingSent(this.record))
            this.status({ kind: 'working', what: 'Waiting for your funds to reach the deposit address' });
          else if (this.snap.status.kind !== 'fund') this.status({ kind: 'fund', sending: null });
        } else if (act === 'wait') {
          this.status({
            kind: 'working',
            what:
              view.state === 'depositing'
                ? 'Bridging in'
                : view.state === 'bridging_back'
                  ? 'Bridging back'
                  : 'Bridging out',
          });
        } else if (act === 'unavailable') {
          this.status({ kind: 'unavailable' });
        } else {
          const stop = await this.onMinted();
          if (stop) return;
        }
        await this.deps.sleep(backends.pollMs);
      }
    } finally {
      this.looping = false;
    }
  }

  /** The coin is minted: take, bridge out, bridge back or wait. True when the loop must stop. */
  private async onMinted(): Promise<boolean> {
    const wallet = this.wallet!;
    try {
      this.status({ kind: 'working', what: 'Syncing the temporary Midnight wallet' });
      await wallet.sync();
      const act = afterMint(this.record, await wallet.balances());
      switch (act) {
        case 'take':
          await this.take();
          return false;
        case 'withdraw-receive':
        case 'withdraw-pay':
          // `await`: a rejection must land in this catch, not escape the loop.
          return await this.withdraw(act === 'withdraw-receive' ? 'receive' : 'pay');
        case 'wait-withdrawal':
          this.status({ kind: 'working', what: 'Waiting for the sponsor to take the withdrawal' });
          return false;
        case 'wait-coin':
          this.status({ kind: 'working', what: 'Waiting for the coin to show in the temporary wallet' });
          return false;
        case 'unavailable':
          this.status({ kind: 'unavailable' });
          return false;
      }
    } catch (e) {
      this.fail(e, true);
      return true;
    }
  }

  private markUnavailable(): void {
    this.saveRecord({ ...this.record, phase: 'unavailable', updatedAt: this.deps.now() });
    this.status({ kind: 'unavailable' });
    // Tell the sponsor (best effort: the page shows "Swap is not available" either way).
    void this.deps.backends.sponsor
      ?.reportTake(this.snap.swapId, this.token!, { outcome: 'not-available' })
      .catch(() => undefined);
  }

  /** The take: offer still live → build → prove at the sponsor → still live → finalize → batcher.
   *  The draft's booked coin is released on every way out that does not submit it. */
  private async take(): Promise<void> {
    const { backends } = this.deps;
    const offerId = this.record.offer.offerId;
    this.status({ kind: 'working', what: 'Checking that the offer is still live' });
    if ((await backends.kernel.offerStatus(offerId)) !== 'live') return this.markUnavailable();
    const detail = await backends.kernel.offer(offerId);
    if (!detail) return this.markUnavailable();
    this.status({ kind: 'working', what: 'Building the take' });
    const draft = await backends.wallet.buildTake(this.wallet!, detail.offerBech32);
    let submitted = false;
    try {
      this.status({ kind: 'working', what: 'Proving the take' });
      const proven = await backends.sponsor!.prove(this.snap.swapId, this.token!, { purpose: 'take', tx: draft.tx });
      if ((await backends.kernel.offerStatus(offerId)) !== 'live') return this.markUnavailable();
      const settlement = backends.wallet.finalizeTake(draft, proven.tx);
      this.status({ kind: 'working', what: 'Submitting the take to the exchange' });
      this.saveRecord({
        ...this.record,
        take: { ...this.record.take, attempts: (this.record.take.attempts ?? 0) + 1 },
        updatedAt: this.deps.now(),
      });
      const res = await backends.wallet.submitTake(this.wallet!, settlement);
      if (res.ok) {
        submitted = true;
        const takeTx = res.transactionHash?.replace(/^0x/, '').toLowerCase();
        this.saveRecord({
          ...this.record,
          take: { ...this.record.take, landed: true, ...(takeTx ? { tx: takeTx } : {}) },
          phase: 'bridging-out',
          updatedAt: this.deps.now(),
        });
        if (takeTx && /^[0-9a-f]{64}$/.test(takeTx))
          void backends
            .sponsor!.reportTake(this.snap.swapId, this.token!, { outcome: 'taken', takeTx })
            .catch(() => undefined);
        return;
      }
      if (res.lostRace) return this.markUnavailable();
      throw new SessionError(
        `The exchange refused the take (${(res.error ?? `HTTP ${res.httpStatus}`).slice(0, 160)}).`,
      );
    } finally {
      if (!submitted) await draft.release();
    }
  }

  /** withdraw-params → build → prove (with its hints) → finalize → the sponsor's withdrawal lane. A
   *  stale answer (the vault's state or its EVM nonce moved on) rebuilds, up to 3 times. True when the
   *  loop must stop (to ask the user). */
  private async withdraw(which: 'receive' | 'pay'): Promise<boolean> {
    const { backends } = this.deps;
    const sponsor = backends.sponsor!;
    const r = this.record;
    if ((r.bridgeOut.refunds ?? 0) >= MAX_AUTO_RETRIES && !this.retryApproved) {
      this.status({
        kind: 'error',
        message: `The withdrawal was refunded ${r.bridgeOut.refunds} times. Your tokens are safe in the temporary wallet; press Retry to try again.`,
        canRetry: true,
      });
      return true;
    }
    this.retryApproved = false;
    const l = which === 'receive' ? r.offer.receive : r.offer.pay;
    for (let attempt = 1; ; attempt++) {
      this.status({
        kind: 'working',
        what: which === 'receive' ? 'Building the withdrawal' : 'Building the bridge back',
      });
      const params = await sponsor.withdrawParams(
        this.snap.swapId,
        this.token!,
        which === 'receive' ? 'swap' : 'bridge-back',
      );
      // Never build a withdrawal of anything but this swap's own leg, to anyone but its owner.
      if (
        params.colour !== l.colour ||
        params.amount !== BigInt(l.amount) ||
        getAddress(params.dest) !== getAddress(r.evmAddress) ||
        params.refundRecipient !== r.temp.coinPk
      )
        throw new SessionError("The sponsor's withdrawal parameters are not this swap's. Nothing was sent.");
      const draft = await backends.wallet.buildWithdraw(this.wallet!, params);
      let view: SwapView;
      try {
        this.status({ kind: 'working', what: 'Proving the withdrawal' });
        const proven = await sponsor.prove(this.snap.swapId, this.token!, {
          purpose: 'withdraw',
          tx: draft.tx,
          coinNonce: draft.coinNonce,
          evmNonce: draft.evmNonce.toString(),
        });
        const bound = backends.wallet.finalizeWithdraw(draft, proven.tx);
        this.status({ kind: 'working', what: 'Submitting the withdrawal to the sponsor' });
        view = await sponsor.withdraw(this.snap.swapId, this.token!, { tx: bound.tx });
      } catch (e) {
        await draft.release();
        if (e instanceof SponsorError && e.rebuild && attempt < 3) {
          this.set({ notice: 'The vault moved on while the withdrawal was being proven; building it again.' });
          continue;
        }
        throw e;
      }
      const next = applyView(
        {
          ...this.record,
          bridgeOut: {
            ...this.record.bridgeOut,
            colour: l.colour,
            attempts: (this.record.bridgeOut.attempts ?? 0) + 1,
          },
          phase: which === 'receive' ? 'bridging-out' : 'bridging-back',
        },
        view,
        this.deps.now(),
      );
      this.saveRecord(next);
      this.set({ view });
      return false;
    }
  }

  // ── user actions ────────────────────────────────────────────────────────

  /** "Bridge back": withdraw the paid token to the user's EVM address (Q6). */
  bridgeBack(): void {
    if (this.snap.status.kind !== 'unavailable') return;
    this.saveRecord({ ...this.record, choice: 'bridge-back', phase: 'bridging-back', updatedAt: this.deps.now() });
    this.status({ kind: 'working', what: 'Bridging back' });
    void this.loop();
  }

  /** Try again after an error that allows it. */
  retry(): void {
    if (this.snap.status.kind !== 'error' || !this.snap.status.canRetry || !this.snap.record || !this.token) return;
    this.retryApproved = true;
    this.set({ notice: null });
    this.status({ kind: 'working', what: 'Trying again' });
    void this.loop();
  }

  /** Stop driving the swap in this tab, and forget its secrets. The record stays. */
  async close(message = 'Stopped in this tab. Resume it from Your swaps.'): Promise<void> {
    if (this.closed) return;
    this.decide?.(false);
    this.closed = true;
    this.seed = null;
    this.token = null;
    const w = this.wallet;
    this.wallet = null;
    await w?.close().catch(() => undefined);
    this.snap = { ...this.snap, status: { kind: 'stopped', message } };
    for (const l of [...this.listeners]) l();
  }

  /** Whether a secret is held (for tests: it must never be on the snapshot or the record). */
  hasSecrets(): boolean {
    return this.seed !== null || this.token !== null;
  }
}

// One swap, driven from this tab: the side effects around the pure decisions in ./flow.ts.
//
//   begin   the offer is still live → "start swap" signed TWICE through the wallet module (the seed,
//           and whether the wallet signs deterministically; if not, the user must confirm that the
//           swap cannot be recovered once the tab closes) → the temporary wallet → the sponsor's
//           open-swap SponsorAction (a third signature) → checks on the answer → the swap record;
//   fund    the two Sepolia transactions from the connected wallet: the sized sweep ETH, then the
//           exact ERC20 amount, both to the deposit address (never more than is missing there). What
//           is sent comes ONLY from the sponsor's open-swap answer, checked against this page's own
//           derivation and the registry, and the offer is checked live first; never from the stored
//           (or imported) record (P4.2-fix C8). Every send first checks the wallet is still on
//           Sepolia with the swap's account, and funding stops while it is not (C9);
//   loop    the sponsor's state, every `pollMs`: bridge-in progress; once minted, the take (offer
//           still live → build → prove at the sponsor → still live → batcher) or "Swap is not
//           available"; then the withdrawal of the received token (or, after Bridge back, of the
//           paid one) → prove → the sponsor's withdrawal lane; a refund or a failed start rebuilds it
//           when the sponsor's view says `withdrawal.retry` (Q9 A; P4.2-fix C1);
//   resume  "start swap" signed ONCE: the re-derived coin key must equal the record's; then the swap
//           is re-opened with the sponsor for a new token, and the loop continues from its state. A
//           failed swap the sponsor marked `recoverable` is resumed the same way (P4.2-fix C5).
//
// The swap's PUBLIC id is keccak256(tag ‖ salt) (P4.2-fix C14): the sponsor, URLs and the snapshot
// see it; the salt stays in this tab and the local record. Secrets stay in memory only: the sponsor's
// swap token here, and the temporary wallet's keys inside the wallet module (the seed is handed to
// `createTempWallet` and never kept: F-A14). Neither is put in the snapshot, the record, a log or an
// error message.

import {
  type NetworkProfile,
  type SwapOffer,
  type TokenRegistry,
  SWAP_KEY_DERIVATION_LATEST,
  classifyOffer,
  newSwapSalt,
  recoverStartSwapSigner,
  startSwapTypedData,
  swapIdFromSalt,
  swapSeedFromSignature,
} from '@evm-midnight-transparent/core';
import { getAddress } from 'ethers';

import { EvmError, type EvmPort, transferData } from './evm.js';
import { MAX_AUTO_RETRIES, afterMint, applyView, nextAction, withdrawalStatus } from './flow.js';
import { lastsLongEnough } from './offers.js';
import type { SwapBackends, TakeDraft, TempWallet, TypedDataSigner } from './ports.js';
import { SWAP_RECORD_VERSION, type SwapRecord, isFinished, isRecoverable } from './record-shape.js';
import {
  type OpenSwapPayload,
  type OpenSwapResponse,
  SponsorError,
  type SweepGas,
  type SwapView,
  openSwapMessage,
  signOpenSwap,
} from './sponsor-client.js';

/** The most sweep ETH the page will send (the sponsor sizes it; G-BRIDGE: 0.0001625 ETH). */
export const MAX_SWEEP_WEI = 3n * 10n ** 15n;

/** How long "Send funds" waits for the sweep transfer to be mined before it asks for the token
 *  transfer (then the user presses Send funds again: the sweep is not sent twice). */
export const SWEEP_RECEIPT_WAIT_MS = 5 * 60_000;
const RECEIPT_POLL_MS = 3_000;

export type SessionStatus =
  | { kind: 'signing'; prompt: 'start-1' | 'start-2' | 'sponsor' | 'resume' }
  /** The two "start swap" signatures differed: waiting for the user to accept or cancel. */
  | { kind: 'confirm-nondeterministic' }
  | { kind: 'opening' }
  /** Waiting for the user's "Send funds"; `sending` while a wallet prompt is open, or while the sweep
   *  transfer is being mined before the token transfer (`confirming`). */
  | { kind: 'fund'; sending: 'checking' | 'eth' | 'confirming' | 'token' | null }
  | { kind: 'working'; what: string }
  /** The offer was gone at take time: waiting for Bridge back. */
  | { kind: 'unavailable' }
  | { kind: 'done' }
  /** `canResume`: a failed swap the sponsor marked recoverable (P4.2-fix C5): Resume revives it. */
  | { kind: 'error'; message: string; canRetry: boolean; canResume?: boolean }
  | { kind: 'stopped'; message: string };

export interface SessionSnapshot {
  /** The swap's PUBLIC id (keccak256(tag ‖ salt)), never the salt. */
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
  /** Why "Send funds" is paused (the wallet left Sepolia or the swap's account; P4.2-fix C9), or null. */
  fundingBlocked: string | null;
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

/** What "Send funds" sends, from the sponsor's open-swap answer checked against this page's own
 *  derivation and the registry (P4.2-fix C8): session memory only, never read back from a record. */
interface VerifiedFunding {
  address: string;
  erc20Address: string;
  amount: bigint;
  sweepGas: Pick<SweepGas, 'gasLimit' | 'maxFeePerGas' | 'ethWei'>;
  ethWei: bigint;
}

const sameLeg = (a: { colour: string; amount: bigint }, b: { colour: string; amount: string }) =>
  a.colour === b.colour && a.amount === BigInt(b.amount);

/** The draft's terms are the record's: the taker gives the pay leg, receives the receive leg. */
function termsAreTheRecords(draft: TakeDraft, offer: SwapRecord['offer']): boolean {
  const { give, receive } = draft.terms;
  return (
    give.length === 1 && receive.length === 1 && sameLeg(give[0]!, offer.pay) && sameLeg(receive[0]!, offer.receive)
  );
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
  /** LOCAL ONLY: the "start swap" salt (never sent, never in a URL or a log; P4.2-fix C14). */
  private readonly salt: string;
  /** SECRET: the sponsor's bearer token for this swap. */
  private token: string | null = null;
  /** What "Send funds" may send (P4.2-fix C8). */
  private funding: VerifiedFunding | null = null;
  private wallet: TempWallet | null = null;
  private looping = false;
  private closed = false;
  private decide: ((ok: boolean) => void) | null = null;
  /** One more automatic withdrawal after MAX_AUTO_RETRIES refunds, approved by the user. */
  private retryApproved = false;

  private constructor(
    salt: string,
    swapId: string,
    offer: SwapOffer | null,
    record: SwapRecord | null,
    deps: SessionDeps,
  ) {
    this.salt = salt;
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
      fundingBlocked: null,
    };
  }

  /** Start a new swap on `offer`. */
  static begin(offer: SwapOffer, deps: SessionDeps): SwapSession {
    const salt = (deps.newSalt ?? (() => newSwapSalt()))().toLowerCase();
    const s = new SwapSession(salt, swapIdFromSalt(salt), offer, null, deps);
    void s.start();
    return s;
  }

  /** Resume a swap from its record (sign the start message again). */
  static resume(record: SwapRecord, deps: SessionDeps): SwapSession {
    const s = new SwapSession(record.salt, record.swapId, null, record, deps);
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

  /** Stopped for good in this tab (an error that allows no retry): a Resume may replace it. */
  get isStuck(): boolean {
    const st = this.snap.status;
    return st.kind === 'error' && !st.canRetry;
  }

  /** Pause "Send funds" (the wallet left Sepolia or the swap's account: P4.2-fix C9), or lift it. */
  setFundingBlocked(reason: string | null): void {
    if (this.snap.fundingBlocked === reason) return;
    this.set({ fundingBlocked: reason, ...(reason ? { notice: reason } : {}) });
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
      const { wallet, deterministic } = await this.newTempWallet(counting);
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
        salt: this.salt,
        derivation: SWAP_KEY_DERIVATION_LATEST,
        network: network.name,
        vault: network.bridge.vaultAddress,
        evmAddress: getAddress(signer.address),
        deterministic,
        offer: { offerId: offer.offerId, pay: leg(offer.pay), receive: leg(offer.receive), expiresAt: offer.expiresAt },
        temp: { coinPk: wallet.coinPk, encPk: wallet.encPk, shieldedAddress: wallet.shieldedAddress },
        deposit: this.depositOf(),
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

  /** The record's deposit block: the verified funding values (P4.2-fix C8). */
  private depositOf(): SwapRecord['deposit'] {
    const f = this.funding;
    if (!f) throw new SessionError('the swap has not been opened with the sponsor');
    return { address: f.address, erc20Address: f.erc20Address, amount: f.amount.toString(), sweepGas: f.sweepGas };
  }

  /** "Start swap" signed twice, and the temporary wallet made from the seed. The salt goes to the
   *  user's own wallet (it is in the message) and nowhere else; the seed lives only in this frame, on
   *  its way to the wallet module, which keeps the keys (F-A14). */
  private async newTempWallet(signer: TypedDataSigner): Promise<{ wallet: TempWallet; deterministic: boolean }> {
    const { backends } = this.deps;
    const derived = await backends.wallet.deriveSwapSeed(signer, this.salt);
    return { wallet: await backends.wallet.createTempWallet(derived.seed), deterministic: derived.deterministic };
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
    if (!token || !token.sepoliaAddress || getAddress(res.erc20Address) !== getAddress(token.sepoliaAddress))
      throw new SessionError('The sponsor named another token contract than the one this swap pays. Nothing was sent.');
    if (res.amount !== pay.amount)
      throw new SessionError('The sponsor asked for another amount than the offer wants. Nothing was sent.');
    const g = res.sweepGas;
    const ethWei = BigInt(g.ethWei);
    if (ethWei <= 0n || ethWei !== BigInt(g.gasLimit) * BigInt(g.maxFeePerGas) || ethWei > MAX_SWEEP_WEI)
      throw new SessionError('The sweep gas the sponsor asks for is not one this page will send. Nothing was sent.');
    // The only values "Send funds" will use (C8): this page's own address, the registry's token, the
    // offer's amount, and the checked sweep gas. Never the record's.
    this.funding = {
      address: mine,
      erc20Address: getAddress(token.sepoliaAddress),
      amount: BigInt(pay.amount),
      sweepGas: { gasLimit: g.gasLimit, maxFeePerGas: g.maxFeePerGas, ethWei: g.ethWei },
      ethWei,
    };
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
      if (isFinished(record) && !isRecoverable(record)) {
        this.status(
          record.phase === 'done'
            ? { kind: 'done' }
            : { kind: 'error', message: record.error ?? 'This swap failed.', canRetry: false },
        );
        return;
      }
      const params = {
        network: record.network,
        vault: record.vault,
        salt: record.salt,
        derivation: record.derivation,
        chainId: this.deps.network.evm.chainId,
      };
      this.status({ kind: 'signing', prompt: 'resume' });
      const signature = await signer.signTypedData(startSwapTypedData(params));
      if (recoverStartSwapSigner(params, signature) !== getAddress(record.evmAddress))
        throw new SessionError('The signature is not from the wallet that started this swap.');
      // The seed goes straight to the wallet module; this object never keeps it (F-A14).
      const wallet = await backends.wallet.createTempWallet(swapSeedFromSignature(signature));
      if (wallet.coinPk !== record.temp.coinPk) {
        await wallet.close();
        throw new SessionError(
          `Your wallet signed the start message differently this time, so this page cannot re-create the swap's Midnight wallet.${
            record.deterministic ? '' : ' This swap was marked as not recoverable when it started.'
          }`,
        );
      }
      this.wallet = wallet;
      void wallet.sync().catch(() => undefined);
      // A re-open: the same terms and keys; a failed swap the sponsor marked recoverable revives.
      const opened = await this.open(record);
      // The record's funding block is replaced by the verified values (an imported record cannot
      // steer "Send funds": C8).
      let next: SwapRecord = { ...this.record, deposit: this.depositOf(), updatedAt: this.deps.now() };
      if (opened.swap) next = applyView(next, opened.swap, this.deps.now());
      this.saveRecord(next);
      void this.loop();
    } catch (e) {
      this.fail(e, false);
    }
  }

  // ── funding ─────────────────────────────────────────────────────────────

  /** "Send funds": the sweep ETH first (so the gas is there when the sponsor starts the deposit),
   *  then the exact token amount; each only if the deposit address still lacks it. The token
   *  transfer waits until the sweep transfer is mined: an EIP-7702-delegated account (a MetaMask
   *  smart account) may have ONE pending transaction, and the node refuses a second one ("in-flight
   *  transaction limit reached for delegated accounts"; plan P3 E.2 attempt 1). */
  async sendFunds(): Promise<void> {
    if (this.snap.status.kind !== 'fund' || this.snap.status.sending !== null) return;
    const { evm } = this.deps;
    try {
      const refusal = this.fundingRefusal();
      if (refusal) throw new SessionError(refusal);
      // C8: only what the sponsor's answer said, as this page checked it; never the record's.
      const f = this.funding;
      if (!f) throw new SessionError('Resume the swap first: this tab has not opened it with the sponsor.');
      this.status({ kind: 'fund', sending: 'checking' });
      await this.bound();
      const r = this.record;
      const amount = f.amount;
      const ethWei = f.ethWei;
      const [ethThere, tokenThere, myEth, myToken] = await Promise.all([
        evm.ethBalance(f.address),
        evm.erc20Balance(f.erc20Address, f.address),
        evm.ethBalance(evm.address),
        evm.erc20Balance(f.erc20Address, evm.address),
      ]);
      const pendingEth = r.funding.eth?.status === 'sent';
      const pendingToken = r.funding.token?.status === 'sent';
      const needEth = !pendingEth && ethThere < ethWei ? ethWei - ethThere : 0n;
      const needToken = !pendingToken && tokenThere < amount ? amount - tokenThere : 0n;
      // C8: before any of the token goes, the offer must still be live with this swap's terms (once
      // some of it is at the deposit address, the rest follows so the funds can bridge in and back).
      if (needToken > 0n && tokenThere === 0n) await this.assertOfferStillOn(r);
      if (needToken > myToken)
        throw new SessionError(
          `Your wallet holds less ${r.offer.pay.symbol} on Sepolia than this swap pays. Nothing was sent.`,
        );
      if (needEth > myEth)
        throw new SessionError('Your wallet holds less Sepolia ETH than the sweep gas. Nothing was sent.');
      let sweepPending: string | null = pendingEth ? r.funding.eth!.hash : null;
      if (needEth > 0n) {
        await this.bound();
        this.status({ kind: 'fund', sending: 'eth' });
        const hash = await evm.sendTransaction({ to: f.address, value: needEth }, 'the sweep gas transfer');
        this.saveRecord({
          ...this.record,
          funding: { ...this.record.funding, eth: { hash, status: 'sent' } },
          updatedAt: this.deps.now(),
        });
        sweepPending = hash;
      }
      if (needToken > 0n && sweepPending) {
        this.status({ kind: 'fund', sending: 'confirming' });
        const outcome = await this.minedOutcome(sweepPending);
        if (outcome === null)
          throw new SessionError(
            'Your sweep gas transfer is not confirmed on Sepolia yet. Press Send funds again once it is: it will not be sent twice.',
          );
        this.saveRecord({
          ...this.record,
          funding: {
            ...this.record.funding,
            eth: { hash: sweepPending, status: outcome === 'success' ? 'confirmed' : 'failed' },
          },
          updatedAt: this.deps.now(),
        });
        if (outcome !== 'success')
          throw new SessionError('Your sweep gas transfer failed on Sepolia. Send the funds again.');
      }
      if (needToken > 0n) {
        // After the wait: the wallet may have changed networks or accounts meanwhile (C9).
        await this.bound();
        this.status({ kind: 'fund', sending: 'token' });
        const hash = await evm.sendTransaction(
          { to: f.erc20Address, data: transferData(f.address, needToken) },
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

  /** Why funding cannot go on right now (mock mode with a real wallet, or the wallet left Sepolia or
   *  the swap's account), or null. */
  private fundingRefusal(): string | null {
    return this.snap.fundingBlocked ?? this.deps.fundingRefusal?.() ?? null;
  }

  /** Before every send and after every wait (P4.2-fix C9): this tab still drives the swap, funding is
   *  not paused, and the wallet itself says it is on Sepolia with the swap's account. */
  private async bound(): Promise<void> {
    if (this.closed) throw new SessionError('The swap stopped in this tab. Nothing more was sent.');
    const refusal = this.fundingRefusal();
    if (refusal) throw new SessionError(refusal);
    await this.deps.evm.ready();
    if (getAddress(this.deps.evm.address) !== getAddress(this.record.evmAddress))
      throw new SessionError('Connect the wallet that started this swap. Nothing more was sent.');
  }

  /** The offer is still live on the exchange, with this swap's two legs, and lasts long enough for a
   *  swap (P4.2-fix C8: funding is checked against the live offer, not the record alone). */
  private async assertOfferStillOn(r: SwapRecord): Promise<void> {
    const { kernel } = this.deps.backends;
    const status = await kernel.offerStatus(r.offer.offerId).catch(() => null);
    if (status === null)
      throw new SessionError(
        'The exchange did not answer, so this page cannot check the offer is still live. Nothing was sent; try again.',
      );
    if (status !== 'live')
      throw new SessionError('This offer is no longer live, so the swap cannot happen. Nothing was sent.');
    const detail = await kernel.offer(r.offer.offerId).catch(() => null);
    const c = detail ? classifyOffer(detail, this.deps.registry) : null;
    const legOf = (l: SwapOffer['pay']) => ({ colour: l.token.midnightColour, amount: l.amount });
    if (
      !c ||
      c.kind !== 'swappable' ||
      !sameLeg(legOf(c.offer.pay), r.offer.pay) ||
      !sameLeg(legOf(c.offer.receive), r.offer.receive)
    )
      throw new SessionError("The exchange lists this offer with other terms than this swap's. Nothing was sent.");
    if (!lastsLongEnough(c.offer, this.deps.now()))
      throw new SessionError('This offer expires before a swap could finish. Nothing was sent.');
  }

  /** The receipt's outcome once the transaction is mined, or null after SWEEP_RECEIPT_WAIT_MS. */
  private async minedOutcome(hash: string): Promise<'success' | 'reverted' | null> {
    const deadline = this.deps.now() + SWEEP_RECEIPT_WAIT_MS;
    for (;;) {
      const outcome = await this.deps.evm.receipt(hash).catch(() => null);
      if (outcome !== null || this.closed) return outcome;
      if (this.deps.now() >= deadline) return null;
      await this.deps.sleep(RECEIPT_POLL_MS);
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
        // A withdrawal ended without a transfer (C1: from the sponsor's signal, not the page's counters).
        const ended = record.bridgeOut.refunds ?? 0;
        if (ended > (before.bridgeOut.refunds ?? 0)) {
          const attempt = ended < MAX_AUTO_RETRIES ? ` (attempt ${ended + 1})` : '';
          this.set({
            notice:
              withdrawalStatus(view).last === 'refunded'
                ? `The withdrawal was refunded to the temporary wallet (another withdrawal used the vault's Sepolia nonce). Retrying${attempt}.`
                : `The sponsor could not start the withdrawal (the vault moved on); your tokens are still in the temporary wallet. Retrying${attempt}.`,
          });
        }
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
              : {
                  kind: 'error',
                  message: record.error ?? 'The swap failed.',
                  canRetry: false,
                  // C5: the sponsor can revive it: Resume (one signature and a re-open).
                  ...(isRecoverable(record) ? { canResume: true } : {}),
                },
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
          const stop = await this.onMinted(view);
          if (stop) return;
        }
        await this.deps.sleep(backends.pollMs);
      }
    } finally {
      this.looping = false;
    }
  }

  /** The coin is minted: take, bridge out, bridge back or wait. True when the loop must stop. */
  private async onMinted(view: SwapView): Promise<boolean> {
    const wallet = this.wallet!;
    try {
      this.status({ kind: 'working', what: 'Syncing the temporary Midnight wallet' });
      await wallet.sync();
      const act = afterMint(this.record, await wallet.balances(), withdrawalStatus(view));
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
    // C10: the offer the exchange served must be this swap's: its id is sha256 of the served bytes,
    // and its terms are read from them. Nothing is proven or submitted otherwise.
    if (draft.offerId !== offerId || !termsAreTheRecords(draft, this.record.offer)) {
      await draft.release();
      throw new SessionError("The exchange served another offer than this swap's. Nothing was taken or sent.");
    }
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
        message: `The withdrawal was refunded or could not start ${r.bridgeOut.refunds} times. Your tokens are safe in the temporary wallet; press Retry to try again.`,
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
    this.token = null;
    this.funding = null;
    const w = this.wallet;
    this.wallet = null;
    await w?.close().catch(() => undefined);
    this.snap = { ...this.snap, status: { kind: 'stopped', message } };
    for (const l of [...this.listeners]) l();
  }

  /** Whether a secret is held: the swap token, or a temporary wallet (whose keys the wallet module
   *  holds). For tests: neither is ever on the snapshot or the record. */
  hasSecrets(): boolean {
    return this.token !== null || this.wallet !== null;
  }
}

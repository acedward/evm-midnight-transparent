// In-memory stand-ins for everything the swap service talks to: Sepolia, the vault (with its
// request maps, a moving state and a controllable relayer), the proof server, the exchange's offers,
// and the transaction reader. No network, no ledger, no ports.
//
// A FAKE TRANSACTION is the UTF-8 JSON of a TxSummary (bigints as strings) behind a marker, so the
// refusal rules run on exactly the summaries a test builds. A fake startWithdraw's call digests are
// computed by the same function as the fake vault's rebuild, over the call's arguments and the
// vault's current state version: change an argument, or move the vault, and the digests differ.

import { createHash } from 'node:crypto';

import { getAddress } from 'ethers';
import type { EvmGasPolicy, KernelOfferStatus, OfferDetail } from '@evm-midnight-transparent/core';

import {
  NotSubmittedError,
  type Attestation,
  type BridgeKind,
  type EvmReader,
  type MidnightTxFacts,
  type OfferReader,
  type OpenRequests,
  type RebuiltWithdraw,
  type RelayOutcome,
  type RelayProgress,
  type SettleCircuit,
  type SwapBackend,
  type SwapProver,
  type WithdrawCallArgs,
} from '../src/swaps/backend.js';
import type { AttestedKind } from '../src/swaps/model.js';
import { InvalidTxError } from '../src/validate/rules.js';
import { callsDigestOf, structureDigestOf, type CallSummary, type TxSummary } from '../src/validate/summary.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const VAULT = '7771c9e5'.padEnd(64, '0');
export const SINGLETON = '5199e7'.padEnd(64, 'a');
export const VAULT_EVM = '0x648216975e722494bFF92E88FFc68C8F8d438FaA';

// ── Fake transactions ──────────────────────────────────────────────────────────

const MARK = 'FAKE-TX:';

export function encodeFakeTx(s: TxSummary): string {
  const json = JSON.stringify(s, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v));
  return Buffer.from(MARK + json, 'utf8').toString('hex');
}

/** A fake transaction's summary; its `erased` form is the whole fake (a fake has no proofs), unless
 *  the summary names one. */
export function fakeInspect(bytes: Uint8Array): TxSummary {
  const text = Buffer.from(bytes).toString('utf8');
  if (!text.startsWith(MARK)) throw new InvalidTxError('not-a-transaction', 'not a transaction');
  const s = JSON.parse(text.slice(MARK.length), (_k, v: unknown) =>
    typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as TxSummary;
  return { ...s, erased: s.erased ?? Buffer.from(bytes).toString('hex') };
}

/** The fake `coinCommitment`: a coin's commitment follows the coin AND the key it is paid to. */
export const fakeCoinCommitment = (coin: { nonce: string; colour: string; value: bigint }, coinPk: string) =>
  sha(`coin:${coinPk}:${coin.nonce}:${coin.colour}:${coin.value}`);

type Shielded = TxSummary['shielded'];

/** Placeholder coins for `guaranteed`'s counts (a user's coins: no contract). */
const coinsFor = (g: TxSummary['guaranteed']): Shielded => ({
  inputs: Array.from({ length: g?.inputs ?? 0 }, (_, i) => ({ nullifier: sha(`fake-in-${i}`), contract: null })),
  outputs: Array.from({ length: g?.outputs ?? 0 }, (_, i) => ({ commitment: sha(`fake-out-${i}`), contract: null })),
});

export function summary(over: Partial<TxSummary> = {}): TxSummary {
  const calls = over.calls ?? [];
  const guaranteed = over.guaranteed === undefined ? { inputs: 1, outputs: 1, transients: 0 } : over.guaranteed;
  const base = {
    intents: 0,
    calls,
    deploys: 0,
    maintenanceUpdates: 0,
    unshielded: false,
    dust: false,
    fallibleShielded: false,
    guaranteed,
    imbalances: {},
    unshieldedImbalances: 0,
    callsDigest: callsDigestOf(calls),
    shielded: coinsFor(guaranteed),
    segments: [0],
    ...over,
  };
  return { ...base, structureDigest: over.structureDigest ?? structureDigestOf(base) };
}

/** The same transaction with other shielded coins (the counts and the structure digest follow). */
export function summaryWith(s: TxSummary, shielded: Shielded): TxSummary {
  const guaranteed = { inputs: shielded.inputs.length, outputs: shielded.outputs.length, transients: 0 };
  const next = { ...s, shielded, guaranteed };
  return { ...next, structureDigest: structureDigestOf(next) };
}

/** The coin a fake startWithdraw hands to the vault (its commitment follows the coin). */
export const fakeVaultOutput = (a: { coinNonce: string; colour: string; amount: bigint }) => ({
  commitment: sha(`vault-coin:${a.coinNonce}:${a.colour}:${a.amount}`),
  contract: VAULT,
});

/** A take's balancing transaction: +pay, -receive in segment 0. */
export function takeTx(
  pay: { colour: string; amount: bigint },
  receive: { colour: string; amount: bigint },
  over: Partial<TxSummary> = {},
) {
  return summary({ imbalances: { '0': { [pay.colour]: pay.amount, [receive.colour]: -receive.amount } }, ...over });
}

/** The two calls of a startWithdraw with these arguments on the vault state `version`. */
export function fakeWithdrawCalls(a: WithdrawCallArgs, version: number): CallSummary[] {
  const args = JSON.stringify({
    nonce: a.evmNonce.toString(),
    gas: [a.gas.gasLimit, a.gas.maxFeePerGas, a.gas.maxPriorityFeePerGas, a.gas.keyVersion].map(String),
    erc20: a.erc20.toLowerCase(),
    amount: a.amount.toString(),
    dest: a.dest.toLowerCase(),
    coin: [a.coinNonce, a.colour],
    refund: a.refundCoinPk,
    version,
  });
  return [
    { address: VAULT, entryPoint: 'startWithdraw', digest: sha(`vault:${args}`) },
    { address: SINGLETON, entryPoint: 'signBidirectional', digest: sha(`singleton:${version}`) },
  ];
}

export function withdrawTx(
  calls: CallSummary[],
  over: Partial<TxSummary> = {},
  coin?: { coinNonce: string; colour: string; amount: bigint },
): TxSummary {
  const shielded = coin
    ? {
        inputs: [{ nullifier: sha(`wallet-coin:${coin.coinNonce}`), contract: null }],
        outputs: [fakeVaultOutput(coin)],
      }
    : undefined;
  return summary({
    intents: 1,
    calls,
    callsDigest: callsDigestOf(calls),
    ...(shielded ? { shielded, guaranteed: { inputs: 1, outputs: 1, transients: 0 } } : {}),
    segments: [0, 1],
    ...over,
  });
}

// ── Sepolia ────────────────────────────────────────────────────────────────────

export class FakeEvm implements EvmReader {
  eth = new Map<string, bigint>();
  erc20 = new Map<string, bigint>();
  nonces = new Map<string, { latest: bigint; pending: bigint }>();
  baseFee = 952_000_000n;
  failing = false;

  private k = (a: string) => a.toLowerCase();
  setEth(a: string, v: bigint) {
    this.eth.set(this.k(a), v);
  }
  setErc20(token: string, holder: string, v: bigint) {
    this.erc20.set(`${this.k(token)}/${this.k(holder)}`, v);
  }
  bumpNonce(a: string) {
    const n = this.nonces.get(this.k(a)) ?? { latest: 0n, pending: 0n };
    this.nonces.set(this.k(a), { latest: n.latest + 1n, pending: n.pending + 1n });
  }
  async ethBalance(a: string) {
    if (this.failing) throw new Error('Sepolia eth_getBalance: unreachable');
    return this.eth.get(this.k(a)) ?? 0n;
  }
  async erc20Balance(token: string, holder: string) {
    if (this.failing) throw new Error('Sepolia eth_call: unreachable');
    return this.erc20.get(`${this.k(token)}/${this.k(holder)}`) ?? 0n;
  }
  async nonce(a: string, tag: 'latest' | 'pending') {
    if (this.failing) throw new Error('Sepolia eth_getTransactionCount: unreachable');
    return this.nonces.get(this.k(a))?.[tag] ?? 0n;
  }
  async baseFeePerGas() {
    return this.baseFee;
  }
}

// ── The vault ──────────────────────────────────────────────────────────────────

export interface FakeRequest {
  kind: BridgeKind;
  id: string;
  path: string;
  evmNonce: bigint;
  signer: string;
  erc20: string;
  amount: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
}

/** What the next relay of a request does. */
export interface RelayPlan {
  kind?: AttestedKind;
  /** Throw this instead (e.g. a signature timeout). */
  fail?: string;
  /** Resolved before the broadcast is reported (lets a test hold a withdrawal in the lane). */
  beforeBroadcast?: Promise<void>;
  /** Resolved before the attestation (lets a test see the lane released first). */
  beforeAttest?: Promise<void>;
}

export class FakeVault implements SwapBackend {
  readonly evm = new FakeEvm();
  readonly vaultAddress = VAULT;
  readonly vaultEvmAddress = VAULT_EVM;
  readonly singletonAddress = SINGLETON;
  /** The vault's state version: every start moves it (the transcripts read it). */
  version = 0;
  readonly requests = new Map<string, FakeRequest>();
  readonly log: string[] = [];
  readonly startNonces: { kind: BridgeKind; nonce: bigint }[] = [];
  relayPlans = new Map<string, RelayPlan>();
  defaultRelay: RelayPlan = {};
  submitStatus = 'SucceedEntirely';
  /** How the next startWithdraw submission fails: before the node (`not-submitted`), or with an
   *  unknown outcome after the start landed (`lost-landed`) or when it did not (`lost`). */
  submitFailure: 'not-submitted' | 'lost-landed' | 'lost' | null = null;
  /** Attestations that already verify for a request (settled or not), by request id. */
  attestations = new Map<string, AttestedKind>();
  private seq = 0;

  depositAddress(coinPk: string) {
    return getAddress(`0x${sha(`deposit:${coinPk}`).slice(0, 40)}`);
  }
  depositPathHex(coinPk: string) {
    return sha(`path:${coinPk}`);
  }
  async openRequests(kind: BridgeKind): Promise<OpenRequests> {
    const mine = [...this.requests.values()].filter((r) => r.kind === kind);
    return {
      ids: mine.map((r) => r.id),
      pathOf: (id) => this.requests.get(id)?.path,
      detailOf: (id) => {
        const r = this.requests.get(id);
        return r
          ? {
              erc20: r.erc20,
              amount: r.amount,
              evmNonce: r.evmNonce,
              gasLimit: r.gasLimit,
              maxFeePerGas: r.maxFeePerGas,
            }
          : undefined;
      },
    };
  }
  private facts(label: string): MidnightTxFacts {
    const n = ++this.seq;
    return {
      txId: `00${sha(`${label}:${n}`).slice(0, 62)}`,
      txHash: sha(`hash:${label}:${n}`),
      status: this.submitStatus,
    };
  }
  async startDeposit(i: {
    recipientCoinPk: string;
    erc20: string;
    amount: bigint;
    gas: EvmGasPolicy;
    evmNonce: bigint;
  }) {
    this.log.push(
      `startDeposit ${i.recipientCoinPk.slice(0, 8)} ${i.amount} gas=${i.gas.gasLimit}x${i.gas.maxFeePerGas}`,
    );
    const id = sha(`deposit:${i.recipientCoinPk}:${this.version}`);
    const signer = this.depositAddress(i.recipientCoinPk);
    this.requests.set(id, {
      kind: 'deposit',
      id,
      path: this.depositPathHex(i.recipientCoinPk),
      evmNonce: i.evmNonce,
      signer,
      erc20: i.erc20,
      amount: i.amount,
      gasLimit: i.gas.gasLimit,
      maxFeePerGas: i.gas.maxFeePerGas,
    });
    this.startNonces.push({ kind: 'deposit', nonce: i.evmNonce });
    this.version++;
    return { ...this.facts('startDeposit'), requestId: id };
  }
  async relay(i: {
    kind: BridgeKind;
    requestId: string;
    expectedSigner: string;
    signatureTimeoutMs: number;
    onProgress: (p: RelayProgress) => void;
  }): Promise<RelayOutcome> {
    const plan = this.relayPlans.get(i.requestId) ?? this.defaultRelay;
    const req = this.requests.get(i.requestId);
    if (!req) throw new Error(`no request ${i.requestId}`);
    if (req.signer.toLowerCase() !== i.expectedSigner.toLowerCase()) throw new Error('wrong expected signer');
    this.log.push(`relay ${i.kind} ${i.requestId.slice(0, 8)}`);
    if (plan.fail) throw new Error(plan.fail);
    i.onProgress({
      stage: 'signed',
      signedTxHash: `0x${sha(`signed:${i.requestId}`)}`,
      from: req.signer,
      nonce: Number(req.evmNonce),
      afterMs: 37_000,
    });
    await plan.beforeBroadcast;
    const kind = plan.kind ?? 'success';
    const evmTxHash = `0x${sha(`evm:${i.requestId}`)}`;
    if (kind === 'never-executed') {
      i.onProgress({ stage: 'not-broadcast', reason: 'nonce already consumed', afterMs: 40_000 });
    } else {
      // The MPC-signed transaction consumes the payer's nonce.
      this.evm.bumpNonce(req.signer);
      this.log.push(`broadcast ${i.kind} ${i.requestId.slice(0, 8)} nonce=${req.evmNonce}`);
      i.onProgress({
        stage: 'broadcast',
        evmTxHash,
        evmBlock: 11_810_095,
        evmStatus: 1,
        alreadyMined: false,
        afterMs: 60_000,
      });
      i.onProgress({ stage: 'finalized', evmBlock: 11_810_095, finalizedBlock: 11_810_200, afterMs: 900_000 });
    }
    await plan.beforeAttest;
    i.onProgress({ stage: 'attested', kind, outputOrigin: 'mpc-cache', afterMs: 1_100_000 });
    return {
      kind,
      event: { requestId: i.requestId },
      serializedOutput: new Uint8Array([kind === 'success' ? 1 : 0]),
      signedTxHash: `0x${sha(`signed:${i.requestId}`)}`,
      signatureAfterMs: 37_000,
      attestationAfterMs: 1_100_000,
      ...(kind === 'never-executed' ? {} : { evmTxHash }),
    };
  }
  async attestation(_kind: BridgeKind, requestId: string): Promise<Attestation | null> {
    const kind = this.attestations.get(requestId);
    return kind ? { kind, event: { requestId }, serializedOutput: new Uint8Array([kind === 'success' ? 1 : 0]) } : null;
  }
  readonly settles: { circuit: SettleCircuit; requestId: string; coinPk: string; encPk: string }[] = [];
  async settle(i: {
    circuit: SettleCircuit;
    requestId: string;
    attestation: Attestation;
    recipientCoinPk: string;
    recipientEncPk: string;
  }) {
    this.log.push(`settle ${i.circuit} ${i.requestId.slice(0, 8)}`);
    this.settles.push({
      circuit: i.circuit,
      requestId: i.requestId,
      coinPk: i.recipientCoinPk,
      encPk: i.recipientEncPk,
    });
    this.requests.delete(i.requestId);
    const minted =
      i.circuit === 'completeDeposit'
        ? i.attestation.kind === 'success'
        : i.circuit === 'refundWithdraw' || i.attestation.kind === 'returned-false';
    return { ...this.facts(i.circuit), minted };
  }
  async abandonDeposit(i: { requestId: string; attestation: Attestation }) {
    this.log.push(`abandonDeposit ${i.requestId.slice(0, 8)}`);
    this.requests.delete(i.requestId);
    return this.facts('abandonDeposit');
  }
  async vaultStateMark(): Promise<string> {
    return `v${this.version}`;
  }
  async rebuildWithdraw(a: WithdrawCallArgs): Promise<RebuiltWithdraw> {
    const calls = fakeWithdrawCalls(a, this.version);
    const callsDigest = callsDigestOf(calls);
    this.pendingWithdrawArgs.set(callsDigest, a);
    return { calls, callsDigest, requestId: sha(`withdraw:${callsDigest}`), outputs: [fakeVaultOutput(a)] };
  }
  /** The request ids of the startWithdraws submitted, in order. */
  readonly submitted: string[] = [];
  pendingWithdrawArgs = new Map<string, WithdrawCallArgs>();
  async submitWithdraw(finalTx: Uint8Array): Promise<MidnightTxFacts> {
    const s = fakeInspect(finalTx);
    const args = this.pendingWithdrawArgs.get(s.callsDigest);
    if (!args) throw new Error('the fake vault does not know this withdrawal (register its args first)');
    const failure = this.submitFailure;
    this.submitFailure = null;
    if (failure === 'not-submitted') throw new NotSubmittedError('the DUST balancing failed');
    if (failure === 'lost') throw new Error('the node did not answer (the transaction was not included)');
    const id = sha(`withdraw:${s.callsDigest}`);
    this.submitted.push(id);
    this.log.push(`startWithdraw nonce=${args.evmNonce} amount=${args.amount}`);
    this.startNonces.push({ kind: 'withdraw', nonce: args.evmNonce });
    this.requests.set(id, {
      kind: 'withdraw',
      id,
      path: 'vault',
      evmNonce: args.evmNonce,
      signer: VAULT_EVM,
      erc20: args.erc20,
      amount: args.amount,
      gasLimit: args.gas.gasLimit,
      maxFeePerGas: args.gas.maxFeePerGas,
    });
    this.version++;
    if (failure === 'lost-landed') throw new Error('the indexer timed out (the transaction landed)');
    return this.facts('startWithdraw');
  }
}

// ── Prover and offers ──────────────────────────────────────────────────────────

export class FakeProver implements SwapProver {
  readonly proved: string[] = [];
  async prove(unproven: Uint8Array) {
    this.proved.push(Buffer.from(unproven).toString('utf8').slice(0, 40));
    return Buffer.concat([Buffer.from('PROVEN:'), Buffer.from(unproven)]);
  }
}

export class FakeOffers implements OfferReader {
  readonly offers = new Map<string, OfferDetail>();
  statusOverride = new Map<string, KernelOfferStatus>();
  makers = new Map<string, Record<string, bigint>>();
  /** sha256 of the maker transaction's bytes by bech32 (default: the offer id the bech32 names). */
  makerIds = new Map<string, string>();

  add(o: {
    offerId: string;
    give: { colour: string; amount: bigint };
    want: { colour: string; amount: bigint };
    expiresInSeconds?: number;
    status?: string;
    type?: string;
  }) {
    const exp = new Date(Date.now() + (o.expiresInSeconds ?? 3 * 3600) * 1000).toISOString();
    this.offers.set(o.offerId, {
      offerId: o.offerId,
      offerBech32: `swapoffer1${o.offerId}`,
      blockHeight: '679000',
      ttlSeconds: null,
      computed: {
        gives: [{ token: o.give.colour, amount: o.give.amount, type: o.type ?? 'SHIELDED' }],
        wants: [{ token: o.want.colour, amount: o.want.amount, type: o.type ?? 'SHIELDED' }],
        expiresAt: exp,
        firstSeenAt: null,
        status: o.status ?? 'live',
      },
    });
    this.makers.set(`swapoffer1${o.offerId}`, { [o.give.colour]: o.give.amount, [o.want.colour]: -o.want.amount });
  }
  async offer(id: string) {
    return this.offers.get(id) ?? null;
  }
  async status(id: string): Promise<KernelOfferStatus> {
    return this.statusOverride.get(id) ?? ((this.offers.get(id)?.computed.status ?? 'not_found') as KernelOfferStatus);
  }
  makerTxId = (bech32: string): string => this.makerIds.get(bech32) ?? bech32.replace(/^swapoffer1/, '');
  makerImbalances = (bech32: string): Record<string, bigint> => {
    const m = this.makers.get(bech32);
    if (!m) throw new Error('unknown offer');
    return m;
  };
}

/** A promise with its resolver, for holding a fake step open. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

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
  type EvmTransaction,
  type EvmTransfer,
  type MidnightTxFacts,
  type OfferReader,
  type OpenRequests,
  type RebuiltWithdraw,
  type RelayOutcome,
  type RelayProgress,
  type SettleCircuit,
  type SubmissionInfo,
  type SwapBackend,
  type SwapProver,
  type TxLookup,
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
  /** What an ERC20 transfer needs (`eth_estimateGas`), by token (default: the measured stk sweep). */
  transferGas = new Map<string, bigint>();
  /** `eth_estimateGas` cannot be read (the floor applies). */
  estimateFails = false;
  readonly estimates: { token: string; from: string; amount: bigint }[] = [];
  block = 11_810_000n;
  /** Every token transfer out of an address (the `Transfer` logs), by token. */
  readonly transfers: (EvmTransfer & { token: string; from: string })[] = [];
  /** The mined transactions whose signed fields are known (`eth_getTransactionByHash`), by hash: a
   *  sweep made by a vault request carries that request's nonce and fee fields (audit U2). */
  readonly txs = new Map<string, EvmTransaction>();
  /** Every `eth_getTransactionByHash` read, in order. */
  readonly txReads: string[] = [];

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
  async estimateTransferGas(token: string, from: string, _to: string, amount: bigint): Promise<bigint | 'reverts'> {
    this.estimates.push({ token: this.k(token), from: this.k(from), amount });
    if (this.estimateFails) throw new Error('Sepolia eth_estimateGas: unreachable');
    // A transfer of more than the sender holds reverts (an OpenZeppelin ERC20).
    if ((this.erc20.get(`${this.k(token)}/${this.k(from)}`) ?? 0n) < amount) return 'reverts';
    return this.transferGas.get(this.k(token)) ?? 29_677n;
  }
  async blockNumber() {
    if (this.failing) throw new Error('Sepolia eth_blockNumber: unreachable');
    return this.block;
  }
  async transfersFrom(token: string, from: string, fromBlock: bigint): Promise<EvmTransfer[]> {
    if (this.failing) throw new Error('Sepolia eth_getLogs: unreachable');
    return this.transfers
      .filter((t) => t.token === this.k(token) && t.from === this.k(from) && t.block >= fromBlock)
      .map(({ txHash, to, amount, block }) => ({ txHash, to, amount, block }));
  }
  async transaction(hash: string): Promise<EvmTransaction | null> {
    if (this.failing) throw new Error('Sepolia eth_getTransactionByHash: unreachable');
    this.txReads.push(hash.toLowerCase());
    return this.txs.get(hash.toLowerCase()) ?? null;
  }
  /** A transfer out of `from` (a sweep): the balance moves and the log is recorded. With `signed`,
   *  the transaction's own fields are known too (a vault request's signed sweep: its nonce and fees). */
  transfer(
    token: string,
    from: string,
    to: string,
    amount: bigint,
    opts: {
      move?: boolean;
      txHash?: string;
      signed?: { nonce: bigint; gasLimit: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas?: bigint };
    } = {},
  ): string {
    const txHash = opts.txHash ?? `0x${sha(`transfer:${token}:${from}:${to}:${amount}:${this.transfers.length}`)}`;
    if (opts.move !== false) {
      const key = `${this.k(token)}/${this.k(from)}`;
      this.erc20.set(key, (this.erc20.get(key) ?? 0n) - amount);
      const dest = `${this.k(token)}/${this.k(to)}`;
      this.erc20.set(dest, (this.erc20.get(dest) ?? 0n) + amount);
    }
    this.block += 1n;
    this.transfers.push({
      token: this.k(token),
      from: this.k(from),
      to: this.k(to),
      amount,
      block: this.block,
      txHash,
    });
    if (opts.signed) {
      this.txs.set(txHash.toLowerCase(), {
        hash: txHash.toLowerCase(),
        from: this.k(from),
        nonce: opts.signed.nonce,
        gasLimit: opts.signed.gasLimit,
        maxFeePerGas: opts.signed.maxFeePerGas,
        ...(opts.signed.maxPriorityFeePerGas !== undefined
          ? { maxPriorityFeePerGas: opts.signed.maxPriorityFeePerGas }
          : {}),
      });
    }
    return txHash;
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
  maxPriorityFeePerGas?: bigint;
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
  /** The clock the vault's reads are stamped with (the harness sets the fake clock), and how far the
   *  indexer's latest block lags behind it (audit S1). */
  clock: () => number = Date.now;
  indexerLagMs = 0;
  /** An attestation lookup that fails (audit S1: it never settles anything). */
  attestationFails = false;
  /** The Midnight transactions on chain, by identifier (audit T1: `findTransaction`). */
  readonly txs = new Map<string, { hash: string; height: number; success: boolean }>();
  /** Whether an executed deposit sweep moves the tokens out of the deposit address (default: the
   *  balances are left to the tests). */
  sweepsMove = false;
  /** How the next sponsor settle (or abandon) ends: its answer lost after it landed (`lost-landed`),
   *  or lost and it did not land (`lost`) (audit T1). */
  settleFailure: 'lost-landed' | 'lost' | null = null;
  /** Settles of other parties (audit T1): the coin's nonce and the key it is sealed to are theirs. */
  readonly foreignSettles: {
    circuit: SettleCircuit | 'abandonDeposit';
    requestId: string;
    mintNonce: string;
    encPk: string;
  }[] = [];
  private seq = 0;

  depositAddress(coinPk: string) {
    return getAddress(`0x${sha(`deposit:${coinPk}`).slice(0, 40)}`);
  }
  depositPathHex(coinPk: string) {
    return sha(`path:${coinPk}`);
  }
  async openRequests(kind: BridgeKind): Promise<OpenRequests> {
    const mine = [...this.requests.values()].filter((r) => r.kind === kind);
    const timeMs = this.clock() - this.indexerLagMs;
    return {
      asOf: { height: Math.floor(timeMs / 6000), timeMs },
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
              ...(r.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: r.maxPriorityFeePerGas } : {}),
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
      maxPriorityFeePerGas: i.gas.maxPriorityFeePerGas,
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
      // The MPC-signed transaction consumes the payer's nonce; a deposit's sweep is a Transfer log out
      // of the deposit address (the balances are left to the tests).
      this.evm.bumpNonce(req.signer);
      if (i.kind === 'deposit' && kind === 'success') {
        this.evm.transfer(req.erc20, req.signer, VAULT_EVM, req.amount, {
          move: this.sweepsMove,
          txHash: evmTxHash,
          signed: this.signedOf(req),
        });
      }
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
  /** The fields of the Sepolia transaction a request asks the MPC to sign. */
  private signedOf(req: FakeRequest) {
    return {
      nonce: req.evmNonce,
      gasLimit: req.gasLimit,
      maxFeePerGas: req.maxFeePerGas,
      ...(req.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: req.maxPriorityFeePerGas } : {}),
    };
  }
  /** The request's sweep executes on Sepolia (anyone's request: its signed transaction, mined): the
   *  tokens leave the deposit address (unless `move` is false) and the `Transfer` log is recorded. */
  sweep(requestId: string, opts: { move?: boolean } = {}): string {
    const req = this.requests.get(requestId);
    if (!req || req.kind !== 'deposit') throw new Error(`no deposit request ${requestId}`);
    this.evm.bumpNonce(req.signer);
    return this.evm.transfer(req.erc20, req.signer, VAULT_EVM, req.amount, {
      ...(opts.move === false ? { move: false } : {}),
      signed: this.signedOf(req),
    });
  }
  async attestation(_kind: BridgeKind, requestId: string): Promise<Attestation | null> {
    if (this.attestationFails) throw new Error('the MPC output cache is unreachable');
    const kind = this.attestations.get(requestId);
    return kind ? { kind, event: { requestId }, serializedOutput: new Uint8Array([kind === 'success' ? 1 : 0]) } : null;
  }
  readonly settles: { circuit: SettleCircuit; requestId: string; coinPk: string; encPk: string }[] = [];
  /**
   * A transaction the sponsor submits: like the vault's circuits, it fails BEFORE reaching the node
   * when the request is gone (the circuit's assertion: "Deposit not found" / "Withdrawal not found").
   * Otherwise `onSubmit` is told its identifier, it lands (recorded in `txs`), and its answer may be
   * lost (`settleFailure`).
   */
  private submitSettle(label: string, requestId: string, onSubmit?: (s: SubmissionInfo) => void): MidnightTxFacts {
    const req = this.requests.get(requestId);
    if (!req) {
      throw new Error(
        `failed assert: ${label === 'completeWithdraw' || label === 'refundWithdraw' ? 'Withdrawal' : 'Deposit'} not found`,
      );
    }
    const f = this.facts(label);
    onSubmit?.({ identifiers: [f.txId], expiresAtMs: this.clock() + 60_000 });
    const failure = this.settleFailure;
    this.settleFailure = null;
    if (failure === 'lost') throw new Error('the node did not answer (the settle was not included)');
    this.requests.delete(requestId);
    this.txs.set(f.txId, { hash: f.txHash!, height: Math.floor(this.clock() / 6000), success: true });
    if (failure === 'lost-landed') throw new Error('the indexer timed out (the settle landed)');
    return f;
  }
  async settle(i: {
    circuit: SettleCircuit;
    requestId: string;
    attestation: Attestation;
    recipientCoinPk: string;
    recipientEncPk: string;
    onSubmit?: (s: SubmissionInfo) => void;
  }) {
    this.log.push(`settle ${i.circuit} ${i.requestId.slice(0, 8)}`);
    this.settles.push({
      circuit: i.circuit,
      requestId: i.requestId,
      coinPk: i.recipientCoinPk,
      encPk: i.recipientEncPk,
    });
    const f = this.submitSettle(i.circuit, i.requestId, i.onSubmit);
    const minted =
      i.circuit === 'completeDeposit'
        ? i.attestation.kind === 'success'
        : i.circuit === 'refundWithdraw' || i.attestation.kind === 'returned-false';
    return { ...f, minted };
  }
  async abandonDeposit(i: { requestId: string; attestation: Attestation; onSubmit?: (s: SubmissionInfo) => void }) {
    this.log.push(`abandonDeposit ${i.requestId.slice(0, 8)}`);
    return this.submitSettle('abandonDeposit', i.requestId, i.onSubmit);
  }
  async findTransaction(identifier: string): Promise<TxLookup> {
    const timeMs = this.clock() - this.indexerLagMs;
    return { found: this.txs.get(identifier) ?? null, asOf: { height: Math.floor(timeMs / 6000), timeMs } };
  }
  /**
   * ANOTHER party settles a request first (audit T1, F-A41): the vault's settles are permissionless;
   * it picks its own mint nonce and seals the coin to its own encryption key. The request is gone and
   * its attestation is the given one. Returns the settle's transaction hash.
   */
  griefSettle(requestId: string, kind: AttestedKind = 'success'): string {
    const req = this.requests.get(requestId);
    if (!req) throw new Error(`no request ${requestId}`);
    const circuit: SettleCircuit | 'abandonDeposit' =
      req.kind === 'deposit'
        ? kind === 'never-executed'
          ? 'abandonDeposit'
          : 'completeDeposit'
        : kind === 'never-executed'
          ? 'refundWithdraw'
          : 'completeWithdraw';
    this.attestations.set(requestId, kind);
    this.requests.delete(requestId);
    this.version++;
    this.foreignSettles.push({
      circuit,
      requestId,
      mintNonce: sha(`griefer-nonce:${requestId}`),
      encPk: sha('griefer-enc-key'),
    });
    const f = this.facts(`grief:${circuit}`);
    this.txs.set(f.txId, { hash: f.txHash!, height: Math.floor(this.clock() / 6000), success: true });
    this.log.push(`grief ${circuit} ${requestId.slice(0, 8)}`);
    return f.txHash!;
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
  async submitWithdraw(
    finalTx: Uint8Array,
    hooks?: { onExpiry?: (expiresAtMs: number) => void },
  ): Promise<MidnightTxFacts> {
    const s = fakeInspect(finalTx);
    const args = this.pendingWithdrawArgs.get(s.callsDigest);
    if (!args) throw new Error('the fake vault does not know this withdrawal (register its args first)');
    const failure = this.submitFailure;
    this.submitFailure = null;
    if (failure === 'not-submitted') throw new NotSubmittedError('the DUST balancing failed');
    hooks?.onExpiry?.(this.clock() + 60_000);
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

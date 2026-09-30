// Taking a kernel offer from the temporary wallet (plan research 2; G-TAKE; lane contract).
//
// A kernel offer is the maker's proven, finalized, IMBALANCED ledger-v9 transaction (MIP-0005
// `swapoffer1…`): it spends the maker's coin of what it gives and creates the maker's coin of what
// it wants. A plain wallet takes it by:
//   1. deserialising it (signature, proof, binding);
//   2. balancing its SHIELDED side from this wallet: spend the wallet's coin of what the maker
//      wants, create the wallet's coin of what the maker gives (no DUST: the wallet has none);
//   3. proving that balancing transaction and binding it;
//   4. merging it into the maker's transaction: the settlement, balanced in every shielded colour
//      and short only of its fee, which the batcher's `midnight-balancer` pays (core batcher.ts).
//
// In the product (lane contract) step 3 is the sponsor's `/prove`:
//   const draft = await buildTake(wallet, offerBech32);          // 1-2: `draft.tx`, unproven hex
//   const { tx } = await sponsor.prove('take', draft.tx);        // 3: proven (pre-binding) hex
//   const settlement = finalizeTake(draft, tx);                  // 3-4: bind, merge, check balanced
//   const result = await submitTake(wallet, settlement);         // the batcher; `lostRace` on 239
// `draft.release()` gives the booked coin back to the wallet when the take is abandoned (a failed
// proof, "Swap is not available"), so the same coin can be bridged back.
//
// A plain wallet's take needs none of MN Bank's Passport segment steering: both parties' legs are
// ordinary guaranteed Zswap offers in segment 0.
//
// Ported from MN Bank (acedward/passport-evm-dapp @ 911647b, test/gates/take/gate.ts `takeAsWallet`
// and relay/src/trade/merge.ts `complementOf`), without Buffer, for the browser.

import * as ledger from '@midnightntwrk/ledger-v9';
import { type ShieldedWalletAPI } from '@midnightntwrk/wallet-sdk-shielded';

import {
  type BatcherResult,
  bytesToHex,
  decodeOffer,
  offerIdOf,
  submitToBatcher,
} from '@evm-midnight-transparent/core';

import { type ProvingService } from './prover.js';
import { internalsOf, type TempWallet } from './temp-wallet.js';
import {
  type AnyTransaction,
  type UnprovenTx,
  assertSameAsDraft,
  contractCalls,
  dustSpendCount,
  erasedHex,
  hasUnshieldedOffers,
  provenFromHex,
  shieldedImbalances,
  txToHex,
  unbalancedColours,
} from './tx.js';

export class TakeError extends Error {
  override name = 'TakeError';
  constructor(
    readonly code:
      | 'unsupported-offer'
      | 'insufficient-funds'
      | 'nothing-to-balance'
      | 'not-balanced'
      | 'proof-mismatch'
      | 'released',
    message: string,
  ) {
    super(message);
  }
}

export type MakerTransaction = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>;

/** `swapoffer1…` → the maker's transaction. */
export function decodeMakerTransaction(offerBech32: string): MakerTransaction {
  return ledger.Transaction.deserialize('signature', 'proof', 'binding', decodeOffer(offerBech32));
}

/** The kernel's offer id of a served offer: sha256 of the maker's transaction bytes AS SERVED (not
 *  re-serialised), so the page can check the kernel served the offer its record names (C10). */
export function servedOfferId(offerBech32: string): string {
  return offerIdOf(decodeOffer(offerBech32));
}

export interface Leg {
  /** The shielded colour, 64 lowercase hex. */
  colour: string;
  /** Base units. */
  amount: bigint;
}

/** What the TAKER gives and receives, read from the maker transaction's own imbalances. */
export interface TakeTerms {
  /** What the maker wants: the taker spends it. */
  give: Leg[];
  /** What the maker gives: the taker receives it. */
  receive: Leg[];
}

/**
 * The terms of a plain shielded offer: its segment-0 imbalances, one entry per shielded colour
 * (positive = the maker's surplus, which the taker receives; negative = the maker's deficit, which
 * the taker pays). Anything else (intents, unshielded legs, fallible offers, contract calls) is
 * refused: the temporary wallet only has a shielded wallet.
 */
export function takeTerms(tx: AnyTransaction): TakeTerms {
  if (tx.intents !== undefined && tx.intents.size > 0) {
    throw new TakeError('unsupported-offer', 'the offer carries intents (unshielded legs or calls)');
  }
  if (tx.fallibleOffer !== undefined && tx.fallibleOffer.size > 0) {
    throw new TakeError('unsupported-offer', 'the offer has fallible shielded legs');
  }
  if (tx.guaranteedOffer === undefined) throw new TakeError('unsupported-offer', 'the offer has no shielded legs');
  const give: Leg[] = [];
  const receive: Leg[] = [];
  for (const [type, value] of tx.imbalances(0)) {
    if (value === 0n) continue;
    if (type.tag !== 'shielded') throw new TakeError('unsupported-offer', `the offer has a ${type.tag} leg`);
    const colour = type.raw.replace(/^0x/, '').toLowerCase();
    if (value > 0n) receive.push({ colour, amount: value });
    else give.push({ colour, amount: -value });
  }
  if (give.length === 0 || receive.length === 0) {
    throw new TakeError('unsupported-offer', 'the offer is not a swap (it must give one thing and want another)');
  }
  return { give, receive };
}

/**
 * Check that `balancing` is exactly this offer's complement from a plain shielded wallet: every
 * shielded colour's imbalance of the maker's transaction plus the balancing one is zero, and the
 * balancing transaction has no contract calls, no unshielded offers and no DUST. The sponsor's
 * `/prove` makes the same check for `purpose: "take"`.
 */
export function assertTakeComplement(makerTx: AnyTransaction, balancing: AnyTransaction): void {
  if (dustSpendCount(balancing) !== 0) throw new TakeError('not-balanced', 'the balancing transaction spends DUST');
  if (contractCalls(balancing).length !== 0 || hasUnshieldedOffers(balancing)) {
    throw new TakeError('not-balanced', 'the balancing transaction does more than move shielded coins');
  }
  const sum = shieldedImbalances(makerTx);
  for (const [colour, v] of Object.entries(shieldedImbalances(balancing))) sum[colour] = (sum[colour] ?? 0n) + v;
  const left = Object.entries(sum).filter(([, v]) => v !== 0n);
  if (left.length > 0) {
    throw new TakeError('not-balanced', `the take does not balance in ${left.map(([c]) => c).join(', ')}`);
  }
}

function assertAffordable(terms: TakeTerms, balances: Record<string, bigint>): void {
  for (const leg of terms.give) {
    const held = balances[leg.colour] ?? 0n;
    if (held < leg.amount) {
      throw new TakeError(
        'insufficient-funds',
        `the wallet holds ${held} of ${leg.colour}, the offer wants ${leg.amount}`,
      );
    }
  }
}

// ── The lane contract: build (unproven) → the sponsor proves → finalize → submit ──

export interface TakeDraft {
  /** The kernel's offer id: sha256 of the maker's transaction bytes as served (`servedOfferId`). */
  readonly offerId: string;
  readonly terms: TakeTerms;
  /** The wallet's unproven balancing transaction, hex: what `/prove` receives for `purpose: "take"`. */
  readonly tx: string;
  readonly balancingMs: number;
  /** The maker's transaction the proven balancing merges into. */
  readonly makerTx: MakerTransaction;
  /** The balancing transaction's identifiers; proving keeps them, so the proven one must carry them all. */
  readonly identifiers: readonly string[];
  /** The balancing transaction with its proofs erased, hex: every input, output (recipient,
   *  ciphertext), and offer as built. A proven answer must erase to exactly this (P4.2-fix C10). */
  readonly erased: string;
  /** Give the booked coins back to the wallet (the take is abandoned). Idempotent. */
  release(): Promise<void>;
  readonly released: boolean;
}

/**
 * Balance the offer's shielded side from the temporary wallet: the unproven transaction `/prove`
 * takes. Refuses offers the wallet cannot pay (`insufficient-funds`) before booking any coin.
 */
export async function buildTake(wallet: TempWallet, offerBech32: string): Promise<TakeDraft> {
  const { keys, opened } = internalsOf(wallet);
  const served = decodeOffer(offerBech32);
  const makerTx: MakerTransaction = ledger.Transaction.deserialize('signature', 'proof', 'binding', served);
  const terms = takeTerms(makerTx);
  assertAffordable(terms, await opened.balances());
  const t0 = performance.now();
  const balancing = await opened.wallet.balanceTransaction(keys.shieldedSecretKeys, makerTx);
  const balancingMs = performance.now() - t0;
  if (balancing === undefined) throw new TakeError('nothing-to-balance', 'the wallet found nothing to balance');
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await opened.wallet.revertTransaction(balancing).catch(() => undefined);
  };
  try {
    assertTakeComplement(makerTx, balancing);
    return {
      offerId: offerIdOf(served),
      terms,
      tx: txToHex(balancing),
      balancingMs,
      makerTx,
      identifiers: balancing.identifiers().map(String),
      erased: erasedHex(balancing),
      release,
      get released() {
        return released;
      },
    };
  } catch (e) {
    await release();
    throw e;
  }
}

export interface TakeSettlement {
  /** The settlement (maker's transaction merged with ours), finalized, hex: what the batcher takes. */
  tx: string;
  txBytes: number;
  offerId: string;
  terms: TakeTerms;
}

/**
 * The proven balancing transaction (from `/prove`) → the settlement: bind it (unless already bound),
 * check it is EXACTLY the draft once proofs are erased (the same inputs, outputs, recipients and
 * ciphertexts; nothing added, nothing changed: P4.2-fix C10) and still the offer's complement with
 * no DUST, merge it into the maker's transaction, and check every shielded colour balances.
 */
export function finalizeTake(draft: TakeDraft, provenHex: string): TakeSettlement {
  if (draft.released) throw new TakeError('released', 'this take was released; build it again');
  const { tx: proven } = provenFromHex(provenHex);
  try {
    assertSameAsDraft(draft, proven);
    assertTakeComplement(draft.makerTx, proven);
  } catch (e) {
    throw new TakeError('proof-mismatch', `the proven transaction is not this take: ${(e as Error).message}`);
  }
  const settlement = draft.makerTx.merge(proven);
  const left = unbalancedColours(settlement);
  if (left.length > 0) throw new TakeError('not-balanced', `the settlement is not balanced in ${left.join(', ')}`);
  const bytes = settlement.serialize();
  return { tx: bytesToHex(bytes), txBytes: bytes.length, offerId: draft.offerId, terms: draft.terms };
}

export interface SubmitTakeResult extends BatcherResult {
  /** The node refused the take because the offer's coin is already spent (239 NullifierAlreadyPresent):
   *  another taker won. The page shows "Swap is not available". */
  lostRace: boolean;
}

const LOST_RACE = /NullifierAlreadyPresent|\b239\b/;

/** Submit the settlement to the exchange's batcher (`midnight-balancer`), which pays its DUST. */
export async function submitTake(
  wallet: TempWallet,
  settlement: TakeSettlement | string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<SubmitTakeResult> {
  const txHex = typeof settlement === 'string' ? settlement : settlement.tx;
  const result = await submitToBatcher({
    batcherUrl: wallet.profile.zswap.batcherUrl,
    target: wallet.profile.zswap.batcherTarget,
    txHex,
    address: wallet.unshieldedAddress,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });
  const text = `${result.error ?? ''} ${typeof result.body === 'string' ? result.body : JSON.stringify(result.body ?? '')}`;
  return { ...result, lostRace: !result.ok && LOST_RACE.test(text) };
}

// ── G-TAKE's one-call form (the gates): balance, prove on a proof server, merge ──

export interface TakeBuild {
  settlement: MakerTransaction;
  /** The settlement's bytes, hex, as the batcher takes it. */
  settlementHex: string;
  terms: TakeTerms;
  /** Milliseconds spent balancing (coin selection) and proving. */
  balancingMs: number;
  provingMs: number;
  /** The balancing transaction's DUST: always zero (asserted), the batcher pays the fee. */
  dustSpends: number;
}

export interface BuildTakeInput {
  makerTx: MakerTransaction;
  wallet: ShieldedWalletAPI;
  secretKeys: ledger.ZswapSecretKeys;
  prover: ProvingService;
  /** The wallet's spendable balances by colour; checked against the terms first. */
  balances: Record<string, bigint>;
  now?: () => number;
}

/**
 * G-TAKE's take in one call, proving on `prover` directly (the gates use it with a Docker proof
 * server). On any failure after coin selection, the booked coins are released (`revertTransaction`),
 * so the wallet can try again or bridge its coin back.
 */
export async function buildTakeWithProver(input: BuildTakeInput): Promise<TakeBuild> {
  const now = input.now ?? (() => performance.now());
  const terms = takeTerms(input.makerTx);
  assertAffordable(terms, input.balances);
  const t0 = now();
  const balancing: UnprovenTx | undefined = await input.wallet.balanceTransaction(input.secretKeys, input.makerTx);
  const balancingMs = now() - t0;
  if (balancing === undefined) throw new TakeError('nothing-to-balance', 'the wallet found nothing to balance');
  try {
    const dustSpends = dustSpendCount(balancing);
    if (dustSpends !== 0) throw new TakeError('not-balanced', 'the balancing transaction spends DUST');
    const t1 = now();
    const proven = await input.prover.prove(balancing);
    const provingMs = now() - t1;
    const settlement = input.makerTx.merge(proven.bind());
    const left = unbalancedColours(settlement);
    if (left.length > 0) {
      throw new TakeError('not-balanced', `the settlement is not balanced in ${left.join(', ')}`);
    }
    return {
      settlement,
      settlementHex: bytesToHex(settlement.serialize()),
      terms,
      balancingMs,
      provingMs,
      dustSpends,
    };
  } catch (e) {
    await input.wallet.revertTransaction(balancing).catch(() => undefined);
    throw e;
  }
}

// Taking a kernel offer from the temporary wallet (plan research 2; G-TAKE).
//
// A kernel offer is the maker's proven, finalized, IMBALANCED ledger-v9 transaction (MIP-0005
// `swapoffer1…`): it spends the maker's coin of what it gives and creates the maker's coin of what
// it wants. A plain wallet takes it by:
//   1. deserialising it (signature, proof, binding);
//   2. balancing its SHIELDED side from this wallet: spend the wallet's coin of what the maker
//      wants, create the wallet's coin of what the maker gives (no DUST: the wallet has none);
//   3. proving that balancing transaction (on our proof server) and binding it;
//   4. merging it into the maker's transaction: the settlement, balanced in every shielded colour
//      and short only of its fee, which the batcher's `midnight-balancer` pays (core batcher.ts).
//
// A plain wallet's take needs none of MN Bank's Passport segment steering: both parties' legs are
// ordinary guaranteed Zswap offers in segment 0.
//
// Ported from MN Bank (acedward/passport-evm-dapp @ 911647b, test/gates/take/gate.ts `takeAsWallet`
// and relay/src/trade/merge.ts `complementOf`), without Buffer, for the browser.

import * as ledger from '@midnightntwrk/ledger-v9';
import { type ShieldedWalletAPI } from '@midnightntwrk/wallet-sdk-shielded';

import { bytesToHex, decodeOffer } from '@evm-midnight-transparent/core';

import { type ProvingService } from './prover.js';

export class TakeError extends Error {
  override name = 'TakeError';
  constructor(
    readonly code: 'unsupported-offer' | 'insufficient-funds' | 'nothing-to-balance' | 'not-balanced',
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
export function takeTerms(tx: ledger.Transaction<ledger.Signaturish, ledger.Proofish, ledger.Bindingish>): TakeTerms {
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

/** Every shielded colour's imbalance in segment 0 (fees aside): zero for a balanced settlement. */
export function shieldedImbalances(
  tx: ledger.Transaction<ledger.Signaturish, ledger.Proofish, ledger.Bindingish>,
): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [type, value] of tx.imbalances(0)) {
    if (type.tag === 'shielded') out[type.raw.replace(/^0x/, '').toLowerCase()] = value;
  }
  return out;
}

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
 * Build the settlement. On any failure after coin selection, the booked coins are released
 * (`revertTransaction`), so the wallet can try again or bridge its coin back.
 */
export async function buildTake(input: BuildTakeInput): Promise<TakeBuild> {
  const now = input.now ?? (() => performance.now());
  const terms = takeTerms(input.makerTx);
  for (const leg of terms.give) {
    const held = input.balances[leg.colour] ?? 0n;
    if (held < leg.amount) {
      throw new TakeError(
        'insufficient-funds',
        `the wallet holds ${held} of ${leg.colour}, the offer wants ${leg.amount}`,
      );
    }
  }
  const t0 = now();
  const balancing = await input.wallet.balanceTransaction(input.secretKeys, input.makerTx);
  const balancingMs = now() - t0;
  if (balancing === undefined) throw new TakeError('nothing-to-balance', 'the wallet found nothing to balance');
  try {
    const dustSpends = [...(balancing.intents?.values() ?? [])].reduce(
      (n, intent) => n + (intent.dustActions?.spends.length ?? 0),
      0,
    );
    if (dustSpends !== 0) throw new TakeError('not-balanced', 'the balancing transaction spends DUST');
    const t1 = now();
    const proven = await input.prover.prove(balancing);
    const provingMs = now() - t1;
    const settlement = input.makerTx.merge(proven.bind());
    const left = Object.entries(shieldedImbalances(settlement)).filter(([, v]) => v !== 0n);
    if (left.length > 0) {
      throw new TakeError('not-balanced', `the settlement is not balanced in ${left.map(([c]) => c).join(', ')}`);
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

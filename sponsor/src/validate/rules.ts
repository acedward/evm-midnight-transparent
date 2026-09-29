// The refusal rules for what a swap may have proven on the sponsor's proof server, or paid for with
// the sponsor's DUST (plan "Lane contracts" items 4 and 5; spec US3 scenario 2). Pure functions over
// a transaction summary (./summary.ts), so every rule is unit-tested without a chain.
//
// TAKE (/prove purpose "take"): the temporary wallet's balancing transaction for THIS swap's offer.
//   - no intents at all: no contract call, deploy or maintenance update, no unshielded offer, no
//     DUST (the batcher pays the take's fee), no fallible shielded offer;
//   - a guaranteed shielded offer of at most MAX_COINS inputs and outputs, no transients;
//   - its segment-0 imbalances are EXACTLY the complement of the maker's: +pay (the coin it
//     spends into the offer) and -receive (the coin it takes out), nothing else. The offer's own
//     imbalances were checked against the swap's terms when it opened, so this transaction
//     balances this offer and no other.
//
// WITHDRAW (/prove purpose "withdraw", and /withdraw): the temporary wallet's `startWithdraw`.
//   - one intent, holding exactly the calls the sponsor itself rebuilt from the swap's values (the
//     vault's `startWithdraw` and the Signet singleton's `signBidirectional` it calls): no other
//     contract, entry point or call, no deploy or maintenance update;
//   - each call's public transcripts equal the rebuilt one's (the arguments: ERC20, amount, the
//     user's EVM address as destination, the coin of this swap's colour and amount, the temporary
//     wallet as refund recipient, the sponsor's gas policy, the EVM nonce);
//   - every segment balanced in every shielded colour (the wallet spends its coin into the
//     contract's output), no other colour moved, no unshielded offer, no DUST (the sponsor adds
//     it), no fallible shielded offer, at most MAX_COINS inputs and outputs.

import type { InvalidTxDetail } from '@evm-midnight-transparent/core';

import type { CallSummary, TxSummary } from './summary.js';

export const MAX_COINS = 4;

export class InvalidTxError extends Error {
  override name = 'InvalidTxError';
  constructor(
    readonly detail: InvalidTxDetail,
    message: string,
  ) {
    super(message);
  }
}

const fail = (detail: InvalidTxDetail, message: string): never => {
  throw new InvalidTxError(detail, message);
};

function commonShape(s: TxSummary, allowCalls: boolean): void {
  if (s.deploys > 0 || s.maintenanceUpdates > 0)
    fail('deploy-or-maintenance', 'the transaction deploys or updates a contract');
  if (!allowCalls && (s.calls.length > 0 || s.intents > 0))
    fail('contract-calls', 'a take carries no contract call and no intent');
  if (s.unshielded) fail('unshielded', 'the transaction moves unshielded tokens');
  if (s.dust) fail('dust', 'the transaction spends or registers DUST');
  if (s.fallibleShielded) fail('fallible', 'the transaction has a fallible shielded offer');
  if (!s.guaranteed) fail('no-shielded', 'the transaction has no shielded offer');
  const g = s.guaranteed!;
  if (g.inputs > MAX_COINS || g.outputs > MAX_COINS || g.transients > 0) {
    fail('too-many-coins', `at most ${MAX_COINS} coins in and out, and no transient coin`);
  }
}

export interface LegTerms {
  colour: string;
  amount: bigint;
}

/** A take for a swap that pays `pay` and receives `receive`. */
export function validateTake(s: TxSummary, terms: { pay: LegTerms; receive: LegTerms }): void {
  commonShape(s, false);
  const segments = Object.keys(s.imbalances);
  if (segments.some((k) => k !== '0')) fail('contract-calls', 'a take has only segment 0');
  const imb = s.imbalances['0'] ?? {};
  const expected: Record<string, bigint> = {
    [terms.pay.colour]: terms.pay.amount,
    [terms.receive.colour]: -terms.receive.amount,
  };
  const extra = Object.keys(imb).filter((c) => !(c in expected));
  if (extra.length > 0) fail('another-colour', 'the transaction moves a colour that is not this swap’s');
  for (const [colour, want] of Object.entries(expected)) {
    const got = imb[colour] ?? 0n;
    if (got === 0n || got > 0n !== want > 0n) {
      fail('wrong-offer', 'the transaction does not balance this swap’s offer (a colour is missing or reversed)');
    }
  }
  for (const [colour, want] of Object.entries(expected)) {
    if (imb[colour] !== want) fail('wrong-amount', 'the transaction balances this offer with other amounts');
  }
}

/** The calls a withdrawal must carry: the sponsor's own rebuild of `startWithdraw` (and its callee). */
export interface ExpectedCalls {
  calls: CallSummary[];
  callsDigest: string;
}

export function validateWithdraw(s: TxSummary, expected: ExpectedCalls, colour: string): void {
  commonShape(s, true);
  if (s.intents !== 1) fail('extra-calls', 'a withdrawal is exactly one intent');
  const addresses = new Set(expected.calls.map((c) => c.address));
  const pairs = new Set(expected.calls.map((c) => `${c.address}/${c.entryPoint}`));
  for (const c of s.calls) {
    if (!addresses.has(c.address)) fail('wrong-contract', 'the transaction calls a contract other than the vault');
    if (!pairs.has(`${c.address}/${c.entryPoint}`))
      fail('wrong-entry-point', `the transaction calls ${c.entryPoint}, not the vault's startWithdraw`);
  }
  if (s.calls.length > expected.calls.length) fail('extra-calls', 'the transaction carries more than one withdrawal');
  if (s.calls.length < expected.calls.length) fail('missing-call', 'the transaction is not a whole startWithdraw');
  for (let i = 0; i < expected.calls.length; i++) {
    const got = s.calls[i]!;
    const want = expected.calls[i]!;
    if (got.address !== want.address || got.entryPoint !== want.entryPoint)
      fail('extra-calls', 'the calls are not the startWithdraw the sponsor expects');
    if (got.digest !== want.digest) {
      fail(
        'wrong-call',
        'the startWithdraw is not this swap’s (its amount, colour, destination, refund recipient, gas or nonce differ)',
      );
    }
  }
  if (s.callsDigest !== expected.callsDigest) fail('wrong-call', 'the calls differ from the expected startWithdraw');
  for (const segment of Object.values(s.imbalances)) {
    for (const [c, v] of Object.entries(segment)) {
      if (v === 0n) continue;
      if (c !== colour) fail('another-colour', 'the transaction moves a colour other than the one withdrawn');
      fail('not-balanced', 'the withdrawn colour is not balanced (the coin must pay the contract’s output exactly)');
    }
  }
}

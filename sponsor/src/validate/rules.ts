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
//     imbalances were checked against the swap's terms when it opened, and its maker transaction
//     against the offer id (sha256 of its bytes), so this transaction balances this offer;
//   - its coins (audit C4, S2): the wallet's coins in (up to MAX_COINS: a partial deposit leaves the
//     wallet the pay amount in two or more coins), the received coin out and at most one change coin;
//     none of a contract. A separately balanced transfer to someone else would need an output that is
//     not the wallet's, which the recipient rule below refuses;
//   - its recipients (audit R1, F-B21): EVERY output is a coin of the temporary wallet. `/prove`
//     discloses each (nonce, colour, value) as `walletOutputs`, the sponsor recomputes each one's
//     commitment with the temporary coin public key (ledger-v9 `coinCommitment`), and an output
//     that is not one of them is refused (`undisclosed-output`): no coin of a take can go to anyone
//     else.
//   - ACCEPTED (audit R1, the orchestrator's disposition): the proof of a take cannot say WHICH maker
//     transaction it will be merged with, only that it is the exact complement of this swap's terms.
//     Open binds the swap to the maker transaction the kernel served (sha256 of its bytes = the
//     offer id), but another offer with the same two legs could be merged with the same proven
//     complement. The sponsor only PROVES a take; the batcher pays its fee, and the coins are the
//     temporary wallet's own, so such a merge costs the sponsor nothing beyond the proof time
//     already bounded by the proof budget, and moves no one else's funds.
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
//     it), no fallible shielded offer, at most MAX_COINS inputs and outputs;
//   - its coins (audit C4, S2): the coin handed to the vault is exactly the rebuild's output (same
//     commitment, owned by the vault), the wallet's coins in (up to MAX_COINS), at most one change coin
//     out; no contract's coin spent or paid otherwise;
//   - its change (audit R1, F-B21): any output besides the vault's coin is a disclosed coin of the
//     temporary wallet (`walletOutputs`, recomputed with its coin public key), so an oversized coin
//     cannot pay the remainder to someone else as "change". `/withdraw` must then carry EXACTLY the
//     transaction `/prove` validated, apart from proofs and the binding: the sponsor keeps the
//     whole proof-erased serialisation and compares it byte for byte (every input, output,
//     recipient ciphertext, call and transcript), not a digest.
//
// INPUTS — ACCEPTED POLICY (audit S7 / F-B36; the orchestrator's disposition, plan 00048 P4.2-fix3):
// the rules bind every OUTPUT to the temporary wallet (or to the vault's coin), but they do NOT bind
// the shielded INPUTS to the temporary wallet: a shielded input carries only a nullifier, which does
// not reveal its owner, and the sponsor holds no key to tell. This is accepted, narrowed as follows:
//   - spending a coin needs its owner's secret key (the spend proof shows the nullifier comes from a
//     coin whose owner key the prover holds), so an input the temporary wallet does not own can only
//     be the CALLER'S OWN money: no one's coin can be spent without its owner;
//   - every output is the temporary wallet's (disclosed and recomputed with its coin public key) or,
//     for a withdrawal, exactly the vault coin of this swap's leg, whose transfer goes to the swap's
//     owner (the destination is in the transcript the sponsor rebuilt). So a third-party-funded input
//     can only DONATE value to this swap's temporary wallet or pay this swap's own leg to its owner;
//   - what the sponsor gives is unchanged by whose coin it is: proof time (bounded by the proof
//     budgets and MAX_COINS) and, for a withdrawal, the DUST of one start of this swap's own leg
//     (bounded per attempt and by the daily budget), which it would pay for the swap's own coin too.
// So an input allow-list would add no protection for anyone's funds or the sponsor's budget. The
// policy is: inputs are any non-contract coins the caller can spend, up to MAX_COINS.

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

/** The commitments (lowercase hex) of the coins a transaction may pay to the temporary wallet: the
 *  sponsor recomputes them from the disclosed `walletOutputs` (audit R1). */
export type WalletCommitments = ReadonlySet<string>;

/** Every output in `outputs` is one of the temporary wallet's disclosed coins. */
function walletOnly(
  outputs: readonly { commitment: string; contract: string | null }[],
  wallet: WalletCommitments | undefined,
  what: string,
): void {
  if (wallet === undefined) return;
  for (const o of outputs) {
    if (o.contract !== null || !wallet.has(o.commitment.toLowerCase())) {
      fail('undisclosed-output', `${what} pays a coin that is not one of the temporary wallet’s disclosed outputs`);
    }
  }
}

/**
 * The take's coins (audit C4, S2): the wallet's pay coins in (1 to MAX_COINS: a partial deposit leaves
 * the pay amount in two or more coins), the received coin out and at most one change coin (1 or 2
 * outputs), every output the wallet's (below). No contract's coin. The inputs are the caller's own
 * (the header's accepted policy, audit S7).
 */
function takeCoins(s: TxSummary, wallet: WalletCommitments | undefined): void {
  const { inputs, outputs } = s.shielded;
  if (inputs.some((i) => i.contract !== null) || outputs.some((o) => o.contract !== null)) {
    fail('contract-coin', 'a take moves no contract’s coin');
  }
  if (inputs.length < 1 || inputs.length > MAX_COINS || outputs.length < 1 || outputs.length > 2) {
    fail('extra-coins', 'a take spends the wallet’s coins and receives the maker’s, with at most one change coin');
  }
  walletOnly(outputs, wallet, 'the take');
}

/**
 * The withdrawal's coins (audit C4, S2): the coin handed to the vault is exactly the output the
 * sponsor's rebuild creates (same commitment: the coin's nonce, colour and value, owned by the
 * vault); besides it, the wallet's coins in (1 to MAX_COINS) and at most one change coin out.
 */
function withdrawCoins(
  s: TxSummary,
  contractOutputs: readonly { commitment: string; contract: string | null }[],
  wallet: WalletCommitments | undefined,
): void {
  const { inputs, outputs } = s.shielded;
  const key = (o: { commitment: string; contract: string | null }) => `${o.commitment}/${o.contract ?? ''}`;
  if (inputs.some((i) => i.contract !== null)) fail('contract-coin', 'a withdrawal spends no contract’s coin');
  const wanted = new Set(contractOutputs.map(key));
  for (const k of wanted) {
    if (!outputs.some((o) => key(o) === k))
      fail('missing-output', 'the coin handed to the vault is not this withdrawal’s');
  }
  const extra = outputs.filter((o) => !wanted.has(key(o)));
  if (extra.some((o) => o.contract !== null))
    fail('contract-coin', 'the transaction pays a contract outside the withdrawal');
  if (inputs.length < 1 || inputs.length > MAX_COINS || extra.length > 1) {
    fail('extra-coins', 'a withdrawal spends the wallet’s coins, with at most one change coin');
  }
  walletOnly(extra, wallet, 'the withdrawal');
}

/** What the service always passes: the disclosed wallet outputs' commitments (audit R1). The shape
 *  tests may leave it out (no recipient check). */
export interface ValidateOptions {
  walletOutputs?: WalletCommitments;
}

/** A take for a swap that pays `pay` and receives `receive`. */
export function validateTake(
  s: TxSummary,
  terms: { pay: LegTerms; receive: LegTerms },
  opts: ValidateOptions = {},
): void {
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
  takeCoins(s, opts.walletOutputs);
}

/** The calls a withdrawal must carry: the sponsor's own rebuild of `startWithdraw` (and its callee),
 *  and, when given, the coins the rebuild hands to the vault (checked coin by coin). */
export interface ExpectedCalls {
  calls: CallSummary[];
  callsDigest: string;
  outputs?: readonly { commitment: string; contract: string | null }[];
}

/** The most a call's declared gas may differ from the sponsor's rebuild, in percent. The callee's
 *  random commitment moves it by far less (about 0.002% measured); a larger gap is another call, or
 *  a declared cost inflated to make the sponsor's DUST pay more. */
export const GAS_TOLERANCE_PERCENT = 1n;

/** Every declared cost of `got` within GAS_TOLERANCE_PERCENT of `want`'s (the same cost names). */
export function gasClose(got: CallSummary['gas'], want: CallSummary['gas']): boolean {
  if (!got || !want) return got === want || (!got && !want);
  for (const part of ['guaranteed', 'fallible'] as const) {
    const a = got[part];
    const b = want[part];
    if (a === null || b === null) {
      if (a !== b) return false;
      continue;
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (a[k] === undefined || b[k] === undefined) return false;
      const x = BigInt(a[k]!);
      const y = BigInt(b[k]!);
      const diff = x > y ? x - y : y - x;
      if (diff * 100n > GAS_TOLERANCE_PERCENT * (y > 0n ? y : 1n)) return false;
    }
  }
  return true;
}

export function validateWithdraw(
  s: TxSummary,
  expected: ExpectedCalls,
  colour: string,
  opts: ValidateOptions = {},
): void {
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
    if (!gasClose(got.gas, want.gas)) fail('wrong-call', 'the call declares another cost than the sponsor’s rebuild');
  }
  if (s.callsDigest !== expected.callsDigest) fail('wrong-call', 'the calls differ from the expected startWithdraw');
  if (expected.outputs) withdrawCoins(s, expected.outputs, opts.walletOutputs);
  for (const segment of Object.values(s.imbalances)) {
    for (const [c, v] of Object.entries(segment)) {
      if (v === 0n) continue;
      if (c !== colour) fail('another-colour', 'the transaction moves a colour other than the one withdrawn');
      fail('not-balanced', 'the withdrawn colour is not balanced (the coin must pay the contract’s output exactly)');
    }
  }
}

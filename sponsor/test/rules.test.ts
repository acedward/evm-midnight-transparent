// The refusal rules, one by one, over transaction summaries (../src/validate/rules.ts): what the
// sponsor proves for a swap, and what it pays DUST for.

import { describe, expect, it } from 'vitest';

import { InvalidTxError, MAX_COINS, validateTake, validateWithdraw } from '../src/validate/rules.js';
import { callsDigestOf, type CallSummary } from '../src/validate/summary.js';
import { SINGLETON, VAULT, summary, takeTx, withdrawTx } from './fakes.js';

const A = 'aa'.repeat(32);
const B = 'bb'.repeat(32);
const C = 'cc'.repeat(32);
const terms = { pay: { colour: A, amount: 104_166_667n }, receive: { colour: B, amount: 1_000_000n } };

const detailOf = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof InvalidTxError) return e.detail;
    throw e;
  }
  return 'accepted';
};

describe('take: the balancing transaction of exactly this swap’s offer', () => {
  const ok = () => takeTx(terms.pay, terms.receive);

  it('accepts +pay and -receive, nothing else', () => {
    expect(detailOf(() => validateTake(ok(), terms))).toBe('accepted');
  });

  it('refuses another offer: a colour missing or reversed (wrong offer)', () => {
    expect(detailOf(() => validateTake(takeTx(terms.receive, terms.pay), terms))).toBe('wrong-offer');
    expect(detailOf(() => validateTake(summary({ imbalances: { '0': { [A]: terms.pay.amount } } }), terms))).toBe(
      'wrong-offer',
    );
  });

  it('refuses a colour that is not this swap’s (another coin / wrong colour)', () => {
    expect(detailOf(() => validateTake(takeTx({ colour: C, amount: terms.pay.amount }, terms.receive), terms))).toBe(
      'another-colour',
    );
    expect(
      detailOf(() =>
        validateTake(
          summary({ imbalances: { '0': { [A]: terms.pay.amount, [B]: -terms.receive.amount, [C]: 5n } } }),
          terms,
        ),
      ),
    ).toBe('another-colour');
  });

  it('refuses other amounts (wrong amount)', () => {
    expect(detailOf(() => validateTake(takeTx({ colour: A, amount: 104_166_666n }, terms.receive), terms))).toBe(
      'wrong-amount',
    );
    expect(detailOf(() => validateTake(takeTx(terms.pay, { colour: B, amount: 1_000_001n }), terms))).toBe(
      'wrong-amount',
    );
  });

  it('refuses contract calls, intents, deploys, unshielded tokens, DUST and fallible offers', () => {
    const call: CallSummary = { address: VAULT, entryPoint: 'startWithdraw', digest: 'd' };
    expect(detailOf(() => validateTake({ ...ok(), calls: [call], intents: 1 }, terms))).toBe('contract-calls');
    expect(detailOf(() => validateTake({ ...ok(), intents: 1 }, terms))).toBe('contract-calls');
    expect(detailOf(() => validateTake({ ...ok(), deploys: 1 }, terms))).toBe('deploy-or-maintenance');
    expect(detailOf(() => validateTake({ ...ok(), maintenanceUpdates: 1 }, terms))).toBe('deploy-or-maintenance');
    expect(detailOf(() => validateTake({ ...ok(), unshielded: true }, terms))).toBe('unshielded');
    expect(detailOf(() => validateTake({ ...ok(), dust: true }, terms))).toBe('dust');
    expect(detailOf(() => validateTake({ ...ok(), fallibleShielded: true }, terms))).toBe('fallible');
    expect(detailOf(() => validateTake({ ...ok(), guaranteed: null }, terms))).toBe('no-shielded');
  });

  it('refuses more than MAX_COINS coins in or out, and transients', () => {
    expect(
      detailOf(() =>
        validateTake({ ...ok(), guaranteed: { inputs: MAX_COINS + 1, outputs: 1, transients: 0 } }, terms),
      ),
    ).toBe('too-many-coins');
    expect(
      detailOf(() =>
        validateTake({ ...ok(), guaranteed: { inputs: 1, outputs: MAX_COINS + 1, transients: 0 } }, terms),
      ),
    ).toBe('too-many-coins');
    expect(detailOf(() => validateTake({ ...ok(), guaranteed: { inputs: 1, outputs: 1, transients: 1 } }, terms))).toBe(
      'too-many-coins',
    );
  });
});

describe('withdraw: exactly the startWithdraw the sponsor rebuilt', () => {
  const calls = (vaultDigest = 'v1', singletonDigest = 's1'): CallSummary[] => [
    { address: VAULT, entryPoint: 'startWithdraw', digest: vaultDigest },
    { address: SINGLETON, entryPoint: 'signBidirectional', digest: singletonDigest },
  ];
  const expected = { calls: calls(), callsDigest: callsDigestOf(calls()) };
  const ok = () => withdrawTx(calls());

  it('accepts the same calls, one intent, balanced', () => {
    expect(detailOf(() => validateWithdraw(ok(), expected, B))).toBe('accepted');
  });

  it('refuses a call with other arguments: amount, destination, colour, refund, gas or nonce (wrong call)', () => {
    expect(detailOf(() => validateWithdraw(withdrawTx(calls('v2')), expected, B))).toBe('wrong-call');
    expect(detailOf(() => validateWithdraw(withdrawTx(calls('v1', 's2')), expected, B))).toBe('wrong-call');
  });

  it('refuses extra calls, a second intent, and a missing call', () => {
    const extra = [...calls(), { address: VAULT, entryPoint: 'startWithdraw', digest: 'v9' }];
    expect(detailOf(() => validateWithdraw(withdrawTx(extra), expected, B))).toBe('extra-calls');
    expect(detailOf(() => validateWithdraw({ ...ok(), intents: 2 }, expected, B))).toBe('extra-calls');
    expect(detailOf(() => validateWithdraw(withdrawTx(calls().slice(0, 1)), expected, B))).toBe('missing-call');
  });

  it('refuses another contract, another entry point, deploys and maintenance updates', () => {
    const other = [{ address: 'dd'.repeat(32), entryPoint: 'startWithdraw', digest: 'v1' }, calls()[1]!];
    expect(detailOf(() => validateWithdraw(withdrawTx(other), expected, B))).toBe('wrong-contract');
    const entry = [{ address: VAULT, entryPoint: 'completeWithdraw', digest: 'v1' }, calls()[1]!];
    expect(detailOf(() => validateWithdraw(withdrawTx(entry), expected, B))).toBe('wrong-entry-point');
    expect(detailOf(() => validateWithdraw({ ...ok(), deploys: 1 }, expected, B))).toBe('deploy-or-maintenance');
  });

  it('refuses another coin moving, an unbalanced colour, DUST, unshielded tokens and fallible offers', () => {
    expect(detailOf(() => validateWithdraw({ ...ok(), imbalances: { '0': { [C]: 1n } } }, expected, B))).toBe(
      'another-colour',
    );
    expect(detailOf(() => validateWithdraw({ ...ok(), imbalances: { '1': { [B]: -1n } } }, expected, B))).toBe(
      'not-balanced',
    );
    expect(detailOf(() => validateWithdraw({ ...ok(), dust: true }, expected, B))).toBe('dust');
    expect(detailOf(() => validateWithdraw({ ...ok(), unshielded: true }, expected, B))).toBe('unshielded');
    expect(detailOf(() => validateWithdraw({ ...ok(), fallibleShielded: true }, expected, B))).toBe('fallible');
    expect(
      detailOf(() =>
        validateWithdraw({ ...ok(), guaranteed: { inputs: MAX_COINS + 1, outputs: 1, transients: 0 } }, expected, B),
      ),
    ).toBe('too-many-coins');
  });
});

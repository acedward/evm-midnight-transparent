// Plan 00048 P4.2-fix3, lane FW3: the audit's S2 (F-A32, F-B33), page side. A completed vault request
// minted LESS than the pay amount to the swap's temporary wallet (a griefer's 1-unit `startDeposit`
// won the sweep race, or a sweep landed between the sponsor's polls): part of the tokens is in the
// temporary wallet, the rest at the deposit address. FS3's sponsor reports it as the state `partial`
// with `partial = {minted, remaining, atAddress, options}` (plan "Lane contracts", P4.2-fix3 lane
// FS3). The page must never wait for that silently, never send the token again, and offer both ways
// out: "Wait for the rest" and "Bridge back" what arrived.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { afterMint, applyView, nextAction, stageTitle, withdrawalStatus } from '../src/swap/flow.js';
import type { MockEnvironment } from '../src/swap/mock/index.js';
import { bridgeBackAmount, partialOf } from '../src/swap/partial.js';
import type { SwapRecord } from '../src/swap/record-shape.js';
import { readSwapRecords, saveSwapRecord } from '../src/swap/records.js';
import { type SessionDeps, SwapSession } from '../src/swap/session.js';
import { type SponsorApi, SponsorError, type SwapView } from '../src/swap/sponsor-client.js';
import { LocalStore } from '../src/store/store.js';
import { expectImportRoundTrip } from './roundtrip.js';
import { FakeSepolia, askOffer, backendsOf, mockEnv, network, registry, testSigner, waitFor } from './swap-fixtures.js';

let env: MockEnvironment;
let store: LocalStore;
const sessions: SwapSession[] = [];

beforeEach(() => {
  localStorage.clear();
  store = new LocalStore(localStorage);
});
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  env?.stop();
});

function deps(signer: ReturnType<typeof testSigner>, evm: FakeSepolia): SessionDeps {
  env.setEvmReader(evm);
  return { backends: backendsOf(env), network, registry, signer, evm, save: (r) => saveSwapRecord(store, r) };
}
const track = (s: SwapSession) => (sessions.push(s), s);
const statusOf = (s: SwapSession) => s.getSnapshot().status;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** What the page sent from the user's wallet: the ETH value, or 'token' for an ERC20 transfer. */
const sentKinds = (evm: FakeSepolia) => evm.sent.map((t) => (t.data ? 'token' : (t.value ?? 0n)));
/** The sponsor calls that write, or that ask for a withdrawal's parameters. */
const sponsorCalls = () =>
  env.sponsor.requests
    .filter((q) => q.method === 'POST' || q.path.endsWith('/withdraw-params'))
    .map((q) => `${q.method} ${q.path.replace(/0x[0-9a-f]{64}/, ':id')}`);

/**
 * A swap funded by the page, whose deposit then turns PARTIAL: the sponsor had not seen the funds
 * when another party's `units`-unit request for this recipient won the sweep race (its sweep spent
 * the sweep ETH at the deposit address); the sponsor completed that request, so `units` reached the
 * temporary wallet and the rest is still at the deposit address.
 */
async function partialSwap(units = 1n, opts: { sponsor?: (api: SponsorApi) => SponsorApi } = {}) {
  env = mockEnv({ stepMs: 25 });
  const offer = await askOffer(env); // pay 1.04 wUSDC, receive 100 wStkA
  const signer = testSigner();
  const evm = new FakeSepolia(signer.address);
  const d = deps(signer, evm);
  if (opts.sponsor) d.backends = { ...d.backends, sponsor: opts.sponsor(d.backends.sponsor!) };
  const s = track(SwapSession.begin(offer, d));
  await waitFor(() => statusOf(s).kind === 'fund', 5_000, 'the funding step');
  env.setEvmReader({ ethBalance: async () => 0n, erc20Balance: async () => 0n });
  await s.sendFunds();
  await waitFor(() => s.getSnapshot().record!.funding.token?.status === 'confirmed', 5_000, 'the receipts');
  const r0 = s.getSnapshot().record!;
  const amount = BigInt(r0.offer.pay.amount);
  const sweep = BigInt(r0.deposit.sweepGas.ethWei);
  evm.erc20.set(`${r0.deposit.erc20Address.toLowerCase()}:${r0.deposit.address.toLowerCase()}`, amount - units);
  evm.eth.set(r0.deposit.address.toLowerCase(), 0n);
  env.controls.partialSweep(units.toString());
  env.setEvmReader(evm);
  await waitFor(() => statusOf(s).kind === 'partial', 5_000, 'the partial-deposit choice');
  return { s, evm, signer, offer, amount, sweep, units };
}

describe('P4.2-fix3 S2: the page reads a partial deposit through one adapter (FS3 items 1–2)', () => {
  type V = Pick<SwapView, 'state' | 'partial' | 'deposit'>;
  const v = (partial: SwapView['partial'], state: SwapView['state'] = 'partial', deposit?: SwapView['deposit']): V => ({
    state,
    partial,
    deposit,
  });
  const both = ['wait', 'bridge-back'];

  it('reads what arrived, what is missing and the options; ignores reports it cannot act on', () => {
    expect(partialOf(v(undefined), 1_040_000n)).toBeNull();
    expect(partialOf(v({ minted: '1', remaining: '1039999', options: both }, 'awaiting_funds'), 1_040_000n)).toBeNull();
    expect(
      partialOf(v({ minted: '1', remaining: '1039999', atAddress: '1039999', options: both }), 1_040_000n),
    ).toEqual({
      minted: 1n,
      remaining: 1_039_999n,
      atAddress: 1_039_999n,
      canWait: true,
      canBridgeBack: true,
      retryAt: null,
    });
    // After a Bridge back of what arrived: nothing in the wallet, the rest to deposit (FS3 item 5).
    expect(partialOf(v({ minted: '0', remaining: '1000000', options: ['wait'] }), 1_040_000n)).toMatchObject({
      canWait: true,
      canBridgeBack: false,
    });
    // An option the numbers do not allow is not offered; an unknown option is ignored.
    expect(partialOf(v({ minted: '0', remaining: '5', options: ['bridge-back', 'x'] }), 1_040_000n)).toMatchObject({
      canWait: false,
      canBridgeBack: false,
    });
    // More than the swap pays, or nothing at all: not acted on.
    expect(partialOf(v({ minted: '40000', remaining: '1000001', options: both }), 1_040_000n)).toBeNull();
    expect(partialOf(v({ minted: '0', remaining: '0', options: both }), 1_040_000n)).toBeNull();
    // A paced start of the rest (deposit stage `rearm-wait`, detail retryAt in unix seconds).
    const paced = v({ minted: '1', remaining: '1039999', options: both }, 'partial', {
      stage: 'rearm-wait',
      stages: [{ stage: 'rearm-wait', at: 1, detail: { retryAt: '1900000000' } }],
    });
    expect(partialOf(paced, 1_040_000n)?.retryAt).toBe(1_900_000_000_000);
  });

  it('titles the new deposit stages', () => {
    expect(stageTitle('deposit', 'partial')).toBe('Part of your deposit reached the temporary wallet');
    expect(stageTitle('deposit', 'rearm-wait')).toMatch(/rest/);
  });
});

describe('P4.2-fix3 S2: a partial deposit, in the session against the mock sponsor', () => {
  it('never waits silently: the page asks the user, keeps reading the sponsor, and sends nothing', async () => {
    const { s, evm, amount } = await partialSwap();
    const r = s.getSnapshot().record!;
    expect(r.partial).toEqual({ minted: '1', remaining: (amount - 1n).toString() });
    expect(r.phase).toBe('bridging-in');
    expect(s.partialChoiceOpen).toBe(true);
    const polls = env.sponsor.requests.length;
    await sleep(250);
    expect(env.sponsor.requests.length).toBeGreaterThan(polls);
    expect(statusOf(s).kind).toBe('partial');
    expect(sentKinds(evm)).toHaveLength(2);
    // The record says it (Your swaps, Resume), holds no secret, and survives Export/Import.
    const [stored] = readSwapRecords(store, { network: 'stagenet', evmAddress: r.evmAddress });
    expect(stored!.partial).toEqual({ minted: '1', remaining: (amount - 1n).toString() });
    expectImportRoundTrip(store, { network: 'stagenet', evmAddress: r.evmAddress });
  });

  it('"Wait for the rest": only the missing sweep ETH is topped up, the rest bridges in, and the swap completes', async () => {
    const { s, evm, sweep } = await partialSwap();
    s.waitForRest();
    expect(s.getSnapshot().record!.partial?.wait).toBe(true);
    // The other request's sweep spent the sweep ETH: the page asks for the ETH only.
    await waitFor(() => statusOf(s).kind === 'fund', 5_000, 'the sweep ETH top-up');
    expect(s.getSnapshot().notice).toMatch(/only the missing ETH is sent; your USDC is not sent again/);
    expect(sentKinds(evm)).toHaveLength(2);
    await s.sendFunds();
    expect(sentKinds(evm)).toEqual([sweep, 'token', sweep]);
    await waitFor(() => statusOf(s).kind === 'done', 15_000, 'the swap');
    const r = s.getSnapshot().record!;
    expect(r.outcome).toBe('swapped');
    // The whole amount arrived: the partial is over; the temporary wallet ends empty.
    expect(r.partial).toBeUndefined();
    expect(env.chain.balances(r.temp.coinPk).size).toBe(0);
    expect(sentKinds(evm)).toEqual([sweep, 'token', sweep]);
  });

  it('"Bridge back": what arrived comes back, then the rest is deposited and bridged back too (FS3 item 5)', async () => {
    const { s, evm, offer, amount, units, sweep } = await partialSwap(40_000n);
    s.bridgeBack();
    // What arrived goes back first (the Bridge back path, for 0.04 USDC), then the sponsor waits for
    // the rest to be deposited: the address lacks the sweep ETH, so the page asks for it (ETH only).
    await waitFor(() => statusOf(s).kind === 'fund', 15_000, 'the sweep ETH top-up for the rest');
    expect(s.getSnapshot().record!.partial).toMatchObject({ minted: '0', remaining: (amount - units).toString() });
    expect(s.getSnapshot().record!.phase).toBe('bridging-back');
    expect(sentKinds(evm)).toHaveLength(2);
    await s.sendFunds();
    expect(sentKinds(evm)).toEqual([sweep, 'token', sweep]);
    await waitFor(() => statusOf(s).kind === 'done', 15_000, 'the second bridge back');
    const r = s.getSnapshot().record!;
    expect(r.outcome).toBe('bridged-back');
    expect(r.choice).toBe('bridge-back');
    expect(r.bridgeOut.colour).toBe(offer.pay.token.midnightColour);
    // Two withdrawals, both settled: neither counted as refunded or failed.
    expect(r.bridgeOut.refunds).toBeUndefined();
    expect(r.bridgeOut.earlier).toHaveLength(1);
    expect(s.getSnapshot().notice ?? '').not.toMatch(/refunded|could not start/);
    // The Bridge back path, twice: withdraw-params (bridge-back) → /prove → /withdraw.
    expect(sponsorCalls()).toEqual([
      'POST /v1/swaps',
      'GET /v1/swaps/:id/withdraw-params',
      'POST /v1/swaps/:id/prove',
      'POST /v1/swaps/:id/withdraw',
      'GET /v1/swaps/:id/withdraw-params',
      'POST /v1/swaps/:id/prove',
      'POST /v1/swaps/:id/withdraw',
    ]);
    expect(env.chain.balances(r.temp.coinPk).size).toBe(0);
    expect(sentKinds(evm)).toEqual([sweep, 'token', sweep]);
  });

  it('"Bridge back" stays available while waiting for the rest (the user is never stuck waiting)', async () => {
    const { s, evm, units } = await partialSwap();
    s.waitForRest();
    await waitFor(() => statusOf(s).kind === 'fund', 5_000, 'the sweep ETH top-up');
    expect(s.partialChoiceOpen).toBe(true);
    s.bridgeBack();
    await waitFor(() => env.sponsor.views()[0]?.state === 'bridging_back', 5_000, 'the bridge back');
    expect(env.sponsor.views()[0]!.withdraw).toMatchObject({ colour: s.getSnapshot().record!.offer.pay.colour });
    expect(
      bridgeBackAmount({ ...s.getSnapshot().record!, partial: { minted: units.toString(), remaining: '1' } }),
    ).toBe(units);
    expect(sentKinds(evm)).toHaveLength(2);
  });

  it('refuses withdrawal parameters for another amount than what arrived: nothing is built or sent', async () => {
    // A sponsor that asks to bridge back the WHOLE pay amount, which the temporary wallet does not hold.
    let whole = false;
    const wrap = (api: SponsorApi): SponsorApi => ({
      nonce: () => api.nonce(),
      openSwap: (r) => api.openSwap(r),
      swap: (i, t) => api.swap(i, t),
      withdrawParams: async (i, t, k) => {
        const p = await api.withdrawParams(i, t, k);
        return whole ? { ...p, amount: 1_040_000n } : p;
      },
      prove: (i, t, b) => api.prove(i, t, b),
      withdraw: (i, t, b) => api.withdraw(i, t, b),
      reportTake: (i, t, r) => api.reportTake(i, t, r),
    });
    const { s, evm } = await partialSwap(1n, { sponsor: wrap });
    whole = true;
    const before = env.controls.walletStats().drafts;
    s.bridgeBack();
    await waitFor(() => statusOf(s).kind === 'error', 5_000, 'the refusal');
    expect(statusOf(s)).toMatchObject({ message: expect.stringMatching(/not this swap's\. Nothing was sent/) });
    expect(env.controls.walletStats().drafts).toBe(before);
    expect(env.sponsor.requests.filter((q) => q.path.endsWith('/prove'))).toEqual([]);
    expect(sentKinds(evm)).toHaveLength(2);
  });

  it('never sends the token again on a partial deposit, even when the record lacks the token transfer', async () => {
    const { s, evm, signer, sweep } = await partialSwap();
    await s.close();
    // The record as another browser (which funded the swap) exported it before its receipts: no token
    // transfer on it.
    const [record] = readSwapRecords(store, { network: 'stagenet', evmAddress: signer.address });
    const edited: SwapRecord = { ...record!, funding: {} };
    saveSwapRecord(store, edited);
    const r = track(SwapSession.resume(edited, deps(signer, evm)));
    await waitFor(() => statusOf(r).kind === 'partial', 5_000, 'the partial-deposit choice after Resume');
    r.waitForRest();
    await waitFor(() => statusOf(r).kind === 'fund', 5_000, 'the sweep ETH top-up');
    await r.sendFunds();
    expect(sentKinds(evm)).toEqual([sweep, 'token', sweep]);
    await waitFor(() => statusOf(r).kind === 'done', 15_000, 'the swap');
    expect(sentKinds(evm)).toEqual([sweep, 'token', sweep]);
  });

  it('a Bridge back answered 409 wrong-state (the rest started depositing meanwhile) is no error: the page waits', async () => {
    let refuseOnce = true;
    const wrap = (api: SponsorApi): SponsorApi => ({
      nonce: () => api.nonce(),
      openSwap: (r) => api.openSwap(r),
      swap: (i, t) => api.swap(i, t),
      withdrawParams: async (i, t, k) => {
        if (refuseOnce) {
          refuseOnce = false;
          throw new SponsorError(409, 'wrong-state', 'the swap is depositing');
        }
        return api.withdrawParams(i, t, k);
      },
      prove: (i, t, b) => api.prove(i, t, b),
      withdraw: (i, t, b) => api.withdraw(i, t, b),
      reportTake: (i, t, r) => api.reportTake(i, t, r),
    });
    const { s, evm } = await partialSwap(1n, { sponsor: wrap });
    const kinds: string[] = [];
    s.subscribe(() => kinds.push(statusOf(s).kind));
    s.bridgeBack();
    await waitFor(() => env.sponsor.views()[0]?.state === 'bridging_back', 5_000, 'the bridge back, on the next view');
    expect(refuseOnce).toBe(false);
    expect(kinds).not.toContain('error');
    expect(sentKinds(evm)).toHaveLength(2);
  });
});

describe('P4.2-fix3 S2: the flow decisions (pure)', () => {
  const base = async () => {
    const { s } = await partialSwap();
    return { record: s.getSnapshot().record!, view: s.getSnapshot().view! };
  };

  it('a sponsor without `partial` (a26438d) keeps the old decisions', async () => {
    const { record, view } = await base();
    const plain: SwapView = { ...view, state: 'awaiting_funds', partial: undefined };
    const noPartial: SwapRecord = { ...record };
    delete noPartial.partial;
    expect(nextAction(noPartial, plain)).toBe('fund');
    expect(applyView(noPartial, plain, 1).partial).toBeUndefined();
    expect(nextAction(record, view)).toBe('partial');
  });

  it('Bridge back of a partial deposit withdraws exactly what arrived, once the wallet shows it', async () => {
    const { record, view } = await base();
    const back: SwapRecord = { ...record, choice: 'bridge-back' };
    expect(nextAction(back, view)).toBe('after-mint');
    const pay = record.offer.pay.colour;
    expect(afterMint(back, {}, { rebuild: true })).toBe('wait-coin');
    expect(afterMint(back, { [pay]: 1n }, { rebuild: true })).toBe('withdraw-pay');
    expect(afterMint(back, { [pay]: 1n }, { rebuild: false })).toBe('wait-withdrawal');
    // Nothing in the wallet to bridge back (after the first part went back): wait for the rest.
    const emptied: SwapView = { ...view, partial: { minted: '0', remaining: '1039999', options: ['wait'] } };
    expect(nextAction(back, emptied)).toBe('partial');
    expect(
      afterMint({ ...back, partial: { minted: '0', remaining: '1039999' } }, { [pay]: 5n }, { rebuild: true }),
    ).toBe('wait-coin');
  });

  it('after a settled Bridge back of the first part, the next part is built (not waited for)', async () => {
    const { view } = await base();
    const after: SwapView = {
      ...view,
      partial: { minted: '1039999', remaining: '0', options: ['bridge-back'] },
      withdraw: { stage: 'completed' },
      withdrawals: [{ stage: 'completed' }],
      withdrawal: { attempts: 1, retry: false },
    };
    expect(withdrawalStatus(after)).toEqual({ ended: 0, rebuild: true, last: null });
    // While a withdrawal runs (not `partial`), nothing is built.
    expect(withdrawalStatus({ ...after, state: 'bridging_back', withdraw: { stage: 'started' } }).rebuild).toBe(false);
    // Two attempts, the first settled and the second refunded: one ended without a transfer.
    const refunded: SwapView = {
      ...after,
      withdrawals: [{ stage: 'completed' }, { stage: 'refunded' }],
      withdraw: { stage: 'refunded' },
      withdrawal: { attempts: 2, last: 'refunded', retry: true },
    };
    expect(withdrawalStatus(refunded)).toEqual({ ended: 1, rebuild: true, last: 'refunded' });
  });

  it('the rest arrived (minted): the record drops the partial and the swap goes on', async () => {
    const { record, view } = await base();
    const whole: SwapView = { ...view, state: 'minted', partial: undefined };
    const next = applyView(record, whole, 2);
    expect(next.partial).toBeUndefined();
    expect(next.phase).toBe('taking');
  });
});

// The swap session (web/src/swap/session.ts) against the mock ports: every stage of a swap, the
// determinism warning, "Swap is not available" + Bridge back, a refunded withdrawal retried, resume
// after the tab closed, and the page's refusals (a deposit address it did not compute, an offer that
// is gone, not enough funds). The records it writes hold no secret and survive Export/Import.

import { KernelClient, START_SWAP_PURPOSE_V2, swapSeedFromSignature } from '@evm-midnight-transparent/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { transferData } from '../src/swap/evm.js';
import { MockChain } from '../src/swap/mock/chain.js';
import type { MockEnvironment } from '../src/swap/mock/index.js';
import { swapIdOf } from '../src/swap/record-shape.js';
import { readSwapRecords, saveSwapRecord } from '../src/swap/records.js';
import { type SessionDeps, SwapSession } from '../src/swap/session.js';
import { LocalStore } from '../src/store/store.js';
import { expectImportRoundTrip } from './roundtrip.js';
import {
  DelegatedSepolia,
  FakeSepolia,
  askOffer,
  backendsOf,
  mockEnv,
  network,
  registry,
  testSigner,
  waitFor,
  type CountingSigner,
} from './swap-fixtures.js';

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

function deps(signer: CountingSigner, evm: FakeSepolia, e: MockEnvironment = env): SessionDeps {
  e.setEvmReader(evm);
  return {
    backends: backendsOf(e),
    network,
    registry,
    signer,
    evm,
    save: (r) => saveSwapRecord(store, r),
  };
}

const track = (s: SwapSession) => {
  sessions.push(s);
  return s;
};

const statusOf = (s: SwapSession) => s.getSnapshot().status;

/** Every stored value of this app, as one string (to look for secrets in). */
const storedText = () => {
  let out = '';
  for (let i = 0; i < localStorage.length; i++) out += localStorage.getItem(localStorage.key(i)!) ?? '';
  return out;
};

describe('a swap, start to finish (happy path)', () => {
  it('signs three times, funds exactly, bridges in, takes, bridges out, and keeps every hash', async () => {
    env = mockEnv();
    const offer = await askOffer(env); // pay 1.04 wUSDC, receive 100 wStkA
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));

    await waitFor(() => statusOf(s).kind === 'fund', 5_000, 'the funding step');
    // Two "start swap" prompts (the same message), then the sponsor's open-swap authorisation.
    expect(signer.prompts.map((p) => p.primaryType)).toEqual(['StartSwap', 'StartSwap', 'SponsorAction']);
    expect(signer.signatures[0]).toBe(signer.signatures[1]);
    expect(s.getSnapshot().deterministic).toBe(true);
    const rec0 = s.getSnapshot().record!;
    expect(rec0.phase).toBe('funding');
    expect(rec0.deposit.address).toBe(env.wallet.depositAddressFor(rec0.temp.coinPk));
    expect(rec0.deposit.amount).toBe('1040000');
    expect(rec0.deposit.erc20Address).toBe(registry.bySymbol('USDC')!.sepoliaAddress);
    // Nothing is sent before the user presses Send funds.
    expect(evm.sent).toEqual([]);

    await s.sendFunds();
    // The sweep ETH first, then the exact token amount, both to the deposit address.
    expect(evm.sent.map((t) => ({ to: t.to, value: t.value ?? 0n, data: t.data ?? '' }))).toEqual([
      { to: rec0.deposit.address, value: BigInt(rec0.deposit.sweepGas.ethWei), data: '' },
      {
        to: rec0.deposit.erc20Address,
        value: 0n,
        data: transferData(rec0.deposit.address, 1_040_000n),
      },
    ]);

    await waitFor(() => statusOf(s).kind === 'done', 10_000, 'the swap to finish');
    const r = s.getSnapshot().record!;
    expect(r.phase).toBe('done');
    expect(r.outcome).toBe('swapped');
    expect(r.funding.eth?.status).toBe('confirmed');
    expect(r.funding.token?.status).toBe('confirmed');
    for (const h of [r.bridgeIn.requestId, r.bridgeIn.startTx, r.bridgeIn.sweepTx, r.bridgeIn.completeTx, r.take.tx])
      expect(h).toMatch(/^(0x|00)?[0-9a-f]{64}$/);
    for (const h of [r.bridgeOut.requestId, r.bridgeOut.startTx, r.bridgeOut.sepoliaTx, r.bridgeOut.completeTx])
      expect(h).toMatch(/^(0x|00)?[0-9a-f]{64}$/);
    expect(r.bridgeOut.colour).toBe(offer.receive.token.midnightColour);
    // The temporary wallet ends empty; the offer is consumed.
    expect(env.chain.balances(r.temp.coinPk).size).toBe(0);
    expect(env.chain.offer(offer.offerId)?.status).toBe('consumed');
    // The sponsor saw: open, the take proven then reported, the withdrawal's params, proof and submission.
    const calls = env.sponsor.requests
      .filter((q) => q.method === 'POST' || q.path.endsWith('/withdraw-params'))
      .map((q) => `${q.method} ${q.path.replace(/0x[0-9a-f]{64}/, ':id')}`);
    expect(calls).toEqual([
      'POST /v1/swaps',
      'POST /v1/swaps/:id/prove',
      'POST /v1/swaps/:id/take',
      'GET /v1/swaps/:id/withdraw-params',
      'POST /v1/swaps/:id/prove',
      'POST /v1/swaps/:id/withdraw',
    ]);
    // Every draft was either submitted or released: none is left booking a coin.
    expect(env.controls.walletStats()).toEqual({ drafts: 2, released: 0 });

    // No secret in the store: no signature (the seed's preimage), no seed, no swap token.
    const text = storedText();
    for (const sig of signer.signatures) expect(text).not.toContain(sig.slice(2, 40));
    expect(text).not.toMatch(/seed|swapToken|signature/i);
    expect(readSwapRecords(store, { network: 'stagenet', evmAddress: signer.address })).toHaveLength(1);
    expectImportRoundTrip(store, { network: 'stagenet', evmAddress: signer.address });
  });
});

describe('the determinism check (Q4)', () => {
  it('stops before the sponsor when the two signatures differ, and cancelling sends nothing', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner({ deterministic: false });
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'confirm-nondeterministic', 5_000, 'the warning');
    expect(signer.signatures[0]).not.toBe(signer.signatures[1]);
    expect(s.getSnapshot().deterministic).toBe(false);
    expect(env.sponsor.requests.some((q) => q.method === 'POST')).toBe(false);
    s.confirmNonDeterministic(false);
    await waitFor(() => statusOf(s).kind === 'stopped', 2_000, 'the stop');
    expect(readSwapRecords(store, { network: 'stagenet', evmAddress: signer.address })).toEqual([]);
    expect(env.sponsor.requests.some((q) => q.method === 'POST')).toBe(false);
  });

  it('continues after the user accepts, and records the swap as not recoverable', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner({ deterministic: false });
    const s = track(SwapSession.begin(offer, deps(signer, new FakeSepolia(signer.address))));
    await waitFor(() => statusOf(s).kind === 'confirm-nondeterministic', 5_000, 'the warning');
    s.confirmNonDeterministic(true);
    await waitFor(() => statusOf(s).kind === 'fund', 5_000, 'the funding step');
    expect(s.getSnapshot().record!.deterministic).toBe(false);
  });
});

describe('"Swap is not available" (Q6)', () => {
  it('stops at the take when the offer is gone, and Bridge back returns the paid token', async () => {
    env = mockEnv({ scenario: { offerGoneAtTake: true } });
    const offer = await askOffer(env);
    const signer = testSigner();
    const s = track(SwapSession.begin(offer, deps(signer, new FakeSepolia(signer.address))));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    await waitFor(() => statusOf(s).kind === 'unavailable', 10_000, '"Swap is not available"');
    const r = s.getSnapshot().record!;
    expect(r.phase).toBe('unavailable');
    expect(r.take.tx).toBeUndefined();
    // No take was proven or submitted; the coin waits in the temporary wallet.
    expect(env.sponsor.requests.filter((q) => q.path.endsWith('/prove'))).toEqual([]);
    expect(env.chain.balances(r.temp.coinPk).get(offer.pay.token.midnightColour)).toBe(offer.pay.amount);

    s.bridgeBack();
    await waitFor(() => statusOf(s).kind === 'done', 10_000, 'the bridge back');
    const done = s.getSnapshot().record!;
    expect(done.outcome).toBe('bridged-back');
    expect(done.choice).toBe('bridge-back');
    expect(done.bridgeOut.colour).toBe(offer.pay.token.midnightColour);
    expect(done.bridgeOut.sepoliaTx).toBeDefined();
    expect(env.chain.balances(r.temp.coinPk).size).toBe(0);
  });
});

describe('a refunded withdrawal (Q9 A)', () => {
  it('is rebuilt and resubmitted automatically, and keeps the refunded one on the record', async () => {
    env = mockEnv({ scenario: { refundFirstWithdrawal: true } });
    const offer = await askOffer(env);
    const signer = testSigner();
    const s = track(SwapSession.begin(offer, deps(signer, new FakeSepolia(signer.address))));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    await waitFor(() => statusOf(s).kind === 'done', 15_000, 'the swap after a refund');
    const r = s.getSnapshot().record!;
    expect(r.outcome).toBe('swapped');
    expect(r.bridgeOut.attempts).toBe(2);
    expect(r.bridgeOut.refunds).toBe(1);
    expect(r.bridgeOut.earlier).toHaveLength(1);
    expect(r.bridgeOut.earlier![0]!.requestId).not.toBe(r.bridgeOut.requestId);
    expect(s.getSnapshot().notice).toMatch(/refunded/);
  });
});

describe('drafts and stale answers (the wallet module and the sponsor as built)', () => {
  it('a stale vault state on /withdraw: the draft is released, rebuilt and proven again', async () => {
    env = mockEnv({ scenario: { staleWithdrawOnce: true } });
    const offer = await askOffer(env);
    const signer = testSigner();
    const s = track(SwapSession.begin(offer, deps(signer, new FakeSepolia(signer.address))));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    await waitFor(() => statusOf(s).kind === 'done', 10_000, 'the swap after a stale answer');
    const proves = env.sponsor.requests.filter((q) => q.path.endsWith('/prove')).length;
    expect(proves).toBe(3); // the take, then the withdrawal twice
    expect(env.controls.walletStats()).toEqual({ drafts: 3, released: 1 });
    expect(s.getSnapshot().record!.bridgeOut.attempts).toBe(1);
  });

  it('the offer goes while the take is proven: the draft is released and the sponsor told', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const d = deps(signer, new FakeSepolia(signer.address));
    const real = env.sponsorFetch;
    const racing = async (url: string, init: RequestInit = {}) => {
      const res = await real(url, init);
      if (url.endsWith('/prove') && String(init.body).includes('"take"')) env.chain.consume(offer.offerId);
      return res;
    };
    const { HttpSponsorApi } = await import('../src/swap/sponsor-client.js');
    d.backends = { ...d.backends, sponsor: new HttpSponsorApi('https://sponsor.mock.invalid', { fetch: racing }) };
    const s = track(SwapSession.begin(offer, d));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    await waitFor(() => statusOf(s).kind === 'unavailable', 10_000, '"Swap is not available"');
    expect(env.controls.walletStats()).toEqual({ drafts: 1, released: 1 });
    await waitFor(() => env.sponsor.requests.some((q) => q.path.endsWith('/take')), 2_000, 'the take report');
  });

  it("refuses withdrawal parameters that are not this swap's (another destination): nothing is built", async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const d = deps(signer, new FakeSepolia(signer.address));
    const real = env.sponsorFetch;
    const lying = async (url: string, init: RequestInit = {}) => {
      const res = await real(url, init);
      if (!url.includes('/withdraw-params')) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, dest: `0x${'12'.repeat(20)}` }), { status: 200 });
    };
    const { HttpSponsorApi } = await import('../src/swap/sponsor-client.js');
    d.backends = { ...d.backends, sponsor: new HttpSponsorApi('https://sponsor.mock.invalid', { fetch: lying }) };
    const s = track(SwapSession.begin(offer, d));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    await waitFor(() => statusOf(s).kind === 'error', 4_000, 'the refusal');
    expect(statusOf(s)).toMatchObject({ message: expect.stringMatching(/withdrawal parameters are not this swap/) });
    expect(env.controls.walletStats()).toEqual({ drafts: 1, released: 0 }); // the take only
    expect(env.sponsor.requests.some((q) => q.path.endsWith('/withdraw'))).toBe(false);
  });
});

describe('resume (US2.2)', () => {
  it('re-derives the wallet with ONE signature, re-opens the swap, and finishes it', async () => {
    env = mockEnv({ stepMs: 25 });
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    await waitFor(() => s.getSnapshot().record?.phase === 'bridging-in', 5_000, 'the bridge-in');
    await s.close(); // the tab closed: the key and the token are gone
    expect(s.hasSecrets()).toBe(false);

    const [record] = readSwapRecords(store, { network: 'stagenet', evmAddress: signer.address });
    const before = signer.prompts.length;
    const r = track(SwapSession.resume(record!, deps(signer, evm)));
    await waitFor(() => statusOf(r).kind === 'done', 10_000, 'the resumed swap');
    // One "start swap" signature and one sponsor authorisation.
    expect(signer.prompts.slice(before).map((p) => p.primaryType)).toEqual(['StartSwap', 'SponsorAction']);
    expect(r.getSnapshot().record!.outcome).toBe('swapped');
    // The funds were not sent twice.
    expect(evm.sent).toHaveLength(2);
  });

  it('refuses when the wallet signs differently: the coin key does not match', async () => {
    env = mockEnv({ stepMs: 25 });
    const offer = await askOffer(env);
    const det = testSigner();
    const s = track(SwapSession.begin(offer, deps(det, new FakeSepolia(det.address))));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.close();
    const [record] = readSwapRecords(store, { network: 'stagenet', evmAddress: det.address });
    const other = testSigner({ deterministic: false, key: det.key });
    const r = track(SwapSession.resume(record!, deps(other, new FakeSepolia(other.address))));
    await waitFor(() => statusOf(r).kind === 'error', 5_000, 'the refusal');
    expect(statusOf(r)).toMatchObject({ message: expect.stringMatching(/signed the start message differently/) });
  });

  it('refuses another wallet', async () => {
    env = mockEnv({ stepMs: 25 });
    const offer = await askOffer(env);
    const a = testSigner();
    const s = track(SwapSession.begin(offer, deps(a, new FakeSepolia(a.address))));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.close();
    const [record] = readSwapRecords(store, { network: 'stagenet', evmAddress: a.address });
    const b = testSigner();
    const r = track(SwapSession.resume(record!, deps(b, new FakeSepolia(b.address))));
    await waitFor(() => statusOf(r).kind === 'error', 5_000);
    expect(b.prompts).toEqual([]);
  });
});

describe('what the page refuses', () => {
  it('an offer that is no longer live: nothing is signed', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    env.chain.consume(offer.offerId);
    const signer = testSigner();
    const s = track(SwapSession.begin(offer, deps(signer, new FakeSepolia(signer.address))));
    await waitFor(() => statusOf(s).kind === 'error', 5_000);
    expect(statusOf(s)).toMatchObject({ message: expect.stringMatching(/no longer live/) });
    expect(signer.prompts).toEqual([]);
  });

  it('a deposit address the page did not compute: nothing is sent, no record', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const d = deps(signer, evm);
    const real = env.sponsor.fetch;
    const lying = async (url: string, init: RequestInit = {}) => {
      const res = await real(url, init);
      if (!url.endsWith('/v1/swaps') || init.method !== 'POST') return res;
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, depositAddress: `0x${'12'.repeat(20)}` }), { status: 200 });
    };
    const { HttpSponsorApi } = await import('../src/swap/sponsor-client.js');
    d.backends = { ...d.backends, sponsor: new HttpSponsorApi('https://sponsor.mock.invalid', { fetch: lying }) };
    const s = track(SwapSession.begin(offer, d));
    await waitFor(() => statusOf(s).kind === 'error', 5_000);
    expect(statusOf(s)).toMatchObject({ message: expect.stringMatching(/deposit address does not match/) });
    expect(evm.sent).toEqual([]);
    expect(readSwapRecords(store, { network: 'stagenet', evmAddress: signer.address })).toEqual([]);
  });

  it('a delegated account (one pending transaction): the token transfer waits until the sweep is mined', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new DelegatedSepolia(signer.address);
    evm.pollsToMine = 3;
    const quick = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 20)));
    const s = track(SwapSession.begin(offer, { ...deps(signer, evm), sleep: quick }));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    expect(evm.refused).toBe(0);
    expect(evm.polls).toBe(3); // it waited for the sweep's receipt
    expect(evm.sent.map((t) => (t.data ? 'token' : 'eth'))).toEqual(['eth', 'token']);
    const r = s.getSnapshot().record!;
    expect(r.funding.eth?.status).toBe('confirmed');
    expect(r.funding.token?.status).toBe('sent');
  });

  it('a sweep not mined in time: a notice; Send funds again sends only the token, never the sweep twice', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new DelegatedSepolia(signer.address);
    evm.pollsToMine = Number.POSITIVE_INFINITY;
    let t = Date.now();
    const quick = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
    const s = track(SwapSession.begin(offer, { ...deps(signer, evm), sleep: quick, now: () => (t += 60_000) }));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    expect(evm.sent).toHaveLength(1);
    expect(s.getSnapshot().notice).toMatch(/not confirmed on Sepolia yet/);
    expect(statusOf(s)).toEqual({ kind: 'fund', sending: null });
    expect(s.getSnapshot().record!.funding.eth?.status).toBe('sent');
    evm.mine();
    await s.sendFunds();
    expect(evm.refused).toBe(0);
    expect(evm.sent.map((x) => (x.data ? 'token' : 'eth'))).toEqual(['eth', 'token']);
  });

  it('funding without enough tokens: a notice, nothing sent', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address, { tokens: { USDC: 1_000_000n } });
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    expect(evm.sent).toEqual([]);
    expect(s.getSnapshot().notice).toMatch(/holds less USDC/);
    expect(statusOf(s)).toEqual({ kind: 'fund', sending: null });
  });

  it('funding refused in mock mode with a real wallet', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(
      SwapSession.begin(offer, { ...deps(signer, evm), fundingRefusal: () => 'Mock mode: connect the mock wallet.' }),
    );
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    expect(evm.sent).toEqual([]);
    expect(s.getSnapshot().notice).toMatch(/Mock mode/);
  });

  it('a declined transfer leaves the step open to try again', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    evm.declineNext = true;
    await s.sendFunds();
    expect(s.getSnapshot().notice).toMatch(/declined/);
    await s.sendFunds();
    expect(evm.sent).toHaveLength(2);
  });
});

// ── P4.2-fix (the security audit's Consolidation rows C1, C5, C8, C9, C10, C14, and F-A14) ──────────

describe('P4.2-fix C1: a withdrawal that ended without a transfer, against the real sponsor wire', () => {
  it('a start that failed after /withdraw accepted it (back to minted, stage failed) is rebuilt and resubmitted', async () => {
    env = mockEnv({ scenario: { failFirstStart: true } });
    const offer = await askOffer(env);
    const signer = testSigner();
    const s = track(SwapSession.begin(offer, deps(signer, new FakeSepolia(signer.address))));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    await waitFor(() => statusOf(s).kind === 'done', 15_000, 'the swap after a failed start');
    const r = s.getSnapshot().record!;
    expect(r.outcome).toBe('swapped');
    expect(r.bridgeOut.attempts).toBe(2);
    expect(r.bridgeOut.refunds).toBe(1); // one attempt ended without a transfer
    expect(env.sponsor.requests.filter((q) => q.path.endsWith('/withdraw')).length).toBe(2);
  });

  it('a refund: the page retries from the sponsor signal, whatever `refunds` counts', async () => {
    env = mockEnv({ scenario: { refundFirstWithdrawal: true } });
    const offer = await askOffer(env);
    const signer = testSigner();
    const s = track(SwapSession.begin(offer, deps(signer, new FakeSepolia(signer.address))));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    await waitFor(
      () => (env.sponsor.views()[0]?.withdraw?.stage === 'refunded' ? true : statusOf(s).kind === 'done'),
      15_000,
      'the refund',
    );
    await waitFor(() => statusOf(s).kind === 'done', 15_000, 'the swap after a refund');
    expect(s.getSnapshot().record!.bridgeOut).toMatchObject({ attempts: 2, refunds: 1 });
  });
});

describe('P4.2-fix C5: a failure the sponsor can revive', () => {
  it('funds-not-received, recoverable: Resume re-opens it and the swap goes on to the end', async () => {
    env = mockEnv({ stepMs: 25 });
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    env.controls.failAwaitingFunds(true);
    await waitFor(() => statusOf(s).kind === 'error', 5_000, 'the failure');
    expect(statusOf(s)).toMatchObject({ kind: 'error', canRetry: false, canResume: true });
    expect(s.getSnapshot().record).toMatchObject({ phase: 'failed', recoverable: true });
    await s.close();

    const [record] = readSwapRecords(store, { network: 'stagenet', evmAddress: signer.address });
    const r = track(SwapSession.resume(record!, deps(signer, evm)));
    await waitFor(() => statusOf(r).kind === 'fund', 5_000, 'the funding step again');
    expect(r.getSnapshot().record).toMatchObject({ phase: 'funding' });
    expect(r.getSnapshot().record!.recoverable).toBeUndefined();
    await r.sendFunds();
    await waitFor(() => statusOf(r).kind === 'done', 10_000, 'the revived swap');
    expect(r.getSnapshot().record!.outcome).toBe('swapped');
  });

  it('a failure that is not recoverable stays final: no signature, no re-open', async () => {
    env = mockEnv({ stepMs: 25 });
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    env.controls.failAwaitingFunds(false);
    await waitFor(() => statusOf(s).kind === 'error', 5_000, 'the failure');
    expect(statusOf(s)).not.toMatchObject({ canResume: true });
    await s.close();
    const [record] = readSwapRecords(store, { network: 'stagenet', evmAddress: signer.address });
    const before = signer.prompts.length;
    const opens = env.sponsor.requests.filter((q) => q.method === 'POST' && q.path === '/v1/swaps').length;
    const r = track(SwapSession.resume(record!, deps(signer, evm)));
    await waitFor(() => statusOf(r).kind === 'error', 5_000);
    expect(signer.prompts.length).toBe(before);
    expect(env.sponsor.requests.filter((q) => q.method === 'POST' && q.path === '/v1/swaps').length).toBe(opens);
  });
});

describe('P4.2-fix C8: Send funds uses only the sponsor answer, checked, never the record', () => {
  it('an edited (imported) record cannot change the token, the amount or the sweep ETH that is sent', async () => {
    env = mockEnv({ stepMs: 25 });
    const offer = await askOffer(env); // pay 1.04 USDC
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    const honest = s.getSnapshot().record!.deposit;
    await s.close();

    // The same swap (same id, keys and deposit address), its funding block edited, e.g. by a
    // "support" contact, and imported back.
    const [record] = readSwapRecords(store, { network: 'stagenet', evmAddress: signer.address });
    const edited = {
      ...record!,
      deposit: {
        ...record!.deposit,
        erc20Address: registry.bySymbol('stkA')!.sepoliaAddress,
        amount: '999000000',
        sweepGas: { gasLimit: '1000000', maxFeePerGas: '3000000000', ethWei: '3000000000000000' },
      },
    };
    saveSwapRecord(store, edited);
    const r = track(SwapSession.resume(edited, deps(signer, evm)));
    await waitFor(() => statusOf(r).kind === 'fund', 5_000);
    // The record is back to the verified values.
    expect(r.getSnapshot().record!.deposit).toEqual(honest);
    await r.sendFunds();
    expect(evm.sent.map((t) => ({ to: t.to, value: t.value ?? 0n, data: t.data ?? '' }))).toEqual([
      { to: honest.address, value: BigInt(honest.sweepGas.ethWei), data: '' },
      { to: honest.erc20Address, value: 0n, data: transferData(honest.address, 1_040_000n) },
    ]);
    expect(honest.erc20Address).toBe(registry.bySymbol('USDC')!.sepoliaAddress);
  });

  it('the offer is no longer live when the funds would go: nothing is sent', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    env.chain.consume(offer.offerId);
    await s.sendFunds();
    expect(evm.sent).toEqual([]);
    expect(s.getSnapshot().notice).toMatch(/no longer live/);
    expect(statusOf(s)).toEqual({ kind: 'fund', sending: null });
  });
});

describe('P4.2-fix C8 with FS C2: a sweep gas the sponsor raises while it waits for the funds', () => {
  it('is adopted (checked, never lowered) and Send funds tops the ETH up: no token twice', async () => {
    env = mockEnv({ stepMs: 25 });
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address, { tokens: { USDC: 1_040_000n } });
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    const first = BigInt(s.getSnapshot().record!.deposit.sweepGas.ethWei);
    env.controls.raiseSweepGas(); // before the page funds: it sends the raised amount at once
    await waitFor(() => BigInt(s.getSnapshot().record!.deposit.sweepGas.ethWei) === first * 2n, 5_000, 'the raise');
    await s.sendFunds();
    expect(evm.sent.map((t) => t.value ?? 0n)).toEqual([first * 2n, 0n]);
    await waitFor(() => statusOf(s).kind === 'done', 10_000, 'the swap');
  });

  it('after the funds went: the fund step comes back and only the missing ETH is sent', async () => {
    env = mockEnv({ stepMs: 25 });
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    // The sponsor has not seen the funds yet: hold its watch by hiding the deposit address's ETH.
    env.setEvmReader({ ethBalance: async () => 0n, erc20Balance: async () => 0n });
    const first = BigInt(s.getSnapshot().record!.deposit.sweepGas.ethWei);
    await s.sendFunds();
    expect(evm.sent).toHaveLength(2);
    env.controls.raiseSweepGas();
    await waitFor(() => statusOf(s).kind === 'fund', 5_000, 'the fund step again');
    expect(s.getSnapshot().notice).toMatch(/gas price rose/);
    env.setEvmReader(evm);
    await s.sendFunds();
    expect(evm.sent.map((t) => (t.data ? 'token' : (t.value ?? 0n)))).toEqual([first, 'token', first]);
    await waitFor(() => statusOf(s).kind === 'done', 10_000, 'the swap');
  });

  it('a sweep gas above what the page sends, or not gasLimit x maxFeePerGas, is refused', async () => {
    env = mockEnv({ stepMs: 25 });
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    const before = s.getSnapshot().record!.deposit.sweepGas;
    for (let i = 0; i < 7; i++) env.controls.raiseSweepGas(); // 2^7 × 0.0001625 ETH > the page's 0.003 cap
    await waitFor(() => /will not send/.test(s.getSnapshot().notice ?? ''), 5_000, 'the refusal');
    expect(s.getSnapshot().record!.deposit.sweepGas).toEqual(before);
  });
});

describe('P4.2-fix C9: funding is bound to Sepolia and the swap account', () => {
  it('the wallet leaves Sepolia while the sweep is confirming: the token transfer is not sent', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new DelegatedSepolia(signer.address);
    evm.pollsToMine = 2;
    const receipt = evm.receipt.bind(evm);
    evm.receipt = async (hash?: string) => {
      evm.chainId = '0x1'; // the user switched networks during the wait
      return receipt(hash);
    };
    const quick = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
    const s = track(SwapSession.begin(offer, { ...deps(signer, evm), sleep: quick }));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    expect(evm.sent.map((t) => (t.data ? 'token' : 'eth'))).toEqual(['eth']);
    expect(s.getSnapshot().notice).toMatch(/not on Sepolia/);
    // Back on Sepolia: only the token goes, the sweep is never sent twice.
    evm.chainId = '0xaa36a7';
    evm.receipt = receipt;
    await s.sendFunds();
    expect(evm.sent.map((t) => (t.data ? 'token' : 'eth'))).toEqual(['eth', 'token']);
  });

  it('checks the wallet before any send, and refuses another account', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    evm.account = `0x${'12'.repeat(20)}`;
    await s.sendFunds();
    expect(evm.sent).toEqual([]);
    expect(s.getSnapshot().notice).toMatch(/another account/);
    evm.account = evm.address;
    evm.chainId = '0x1';
    await s.sendFunds();
    expect(evm.sent).toEqual([]);
    evm.chainId = '0xaa36a7';
    await s.sendFunds();
    expect(evm.sent).toHaveLength(2);
    expect(evm.readyCalls).toBeGreaterThanOrEqual(3);
  });

  it('a network change pauses funding (chainChanged) until the wallet is back', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const evm = new FakeSepolia(signer.address);
    const s = track(SwapSession.begin(offer, deps(signer, evm)));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    s.setFundingBlocked('Your wallet switched away from Sepolia: funding is paused.');
    expect(s.getSnapshot().fundingBlocked).toMatch(/paused/);
    await s.sendFunds();
    expect(evm.sent).toEqual([]);
    s.setFundingBlocked(null);
    await s.sendFunds();
    expect(evm.sent).toHaveLength(2);
  });
});

describe('P4.2-fix C10: the take is built only from this swap own offer', () => {
  it('the exchange serves another maker transaction for this offer id: refused before /prove, the coin released', async () => {
    env = mockEnv();
    const offer = await askOffer(env); // pay 1.04 USDC, receive 100 stkA
    // An offer wanting the same 1.04 USDC for 1 base unit of stkA, served under the real offer id.
    const colour = (n: string) => registry.byMidnightName(n)!.midnightColour;
    const evil = env.chain.addOffer(
      'evil',
      [{ token: colour('wStkA'), amount: 1n, type: 'SHIELDED' }],
      [{ token: colour('wUSDC'), amount: 1_040_000n, type: 'SHIELDED' }],
      86_400_000,
    );
    const lyingKernel = async (url: string, init?: RequestInit) => {
      const res = await env.kernelFetch(url, init);
      if (!new URL(url).pathname.endsWith(`/v1/offers/${offer.offerId}`)) return res;
      const body = (await res.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, offerBech32: MockChain.offerBech32(evil) }), { status: 200 });
    };
    const signer = testSigner();
    const d = deps(signer, new FakeSepolia(signer.address));
    d.backends = {
      ...d.backends,
      kernel: new KernelClient({ baseUrl: network.zswap.kernelUrl, fetch: lyingKernel, retries: 0 }),
    };
    const s = track(SwapSession.begin(offer, d));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    await waitFor(() => statusOf(s).kind === 'error', 10_000, 'the refusal');
    expect(statusOf(s)).toMatchObject({
      message: expect.stringMatching(/another offer than this swap/),
      canRetry: true,
    });
    expect(env.sponsor.requests.some((q) => q.path.endsWith('/prove'))).toBe(false);
    expect(env.controls.walletStats()).toEqual({ drafts: 1, released: 1 });
    expect(env.chain.offer(evil)?.status).toBe('live');
  });
});

describe('P4.2-fix C14 and F-A14: the salt stays in the page, the seed is not kept', () => {
  it('the sponsor sees only the public id: no request carries the salt; the record keeps it locally', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const salt = `0x${'3c'.repeat(32)}`;
    const d = deps(signer, new FakeSepolia(signer.address));
    const seen: Array<{ method: string; url: string; headers: string; body: string }> = [];
    const real = env.sponsorFetch;
    const watching = async (url: string, init: RequestInit = {}) => {
      seen.push({
        method: (init.method ?? 'GET').toUpperCase(),
        url,
        headers: JSON.stringify([...new Headers(init.headers).entries()]),
        body: typeof init.body === 'string' ? init.body : '',
      });
      return real(url, init);
    };
    const { HttpSponsorApi } = await import('../src/swap/sponsor-client.js');
    d.backends = { ...d.backends, sponsor: new HttpSponsorApi('https://sponsor.mock.invalid', { fetch: watching }) };
    const s = track(SwapSession.begin(offer, { ...d, newSalt: () => salt }));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    await waitFor(() => statusOf(s).kind === 'done', 10_000);

    const id = swapIdOf(salt);
    expect(s.getSnapshot().swapId).toBe(id);
    const r = s.getSnapshot().record!;
    expect(r).toMatchObject({ v: 2, swapId: id, salt, derivation: 2 });
    // The open-swap body names the public id, and its signature covers it.
    const open = JSON.parse(seen.find((x) => x.method === 'POST' && x.url.endsWith('/v1/swaps'))!.body);
    expect(open.swap).toBe(id);
    expect(open.auth.message.swap).toBe(id);
    // Not one request (URL, headers or body) carries the salt.
    const hex = salt.slice(2);
    expect(seen.length).toBeGreaterThan(5);
    for (const x of seen) expect(JSON.stringify(x)).not.toContain(hex);
    // The "start swap" prompts are derivation 2: the warning.
    const starts = signer.prompts.filter((p) => p.primaryType === 'StartSwap');
    expect(starts).toHaveLength(2);
    for (const p of starts)
      expect((p.message as { purpose: string; salt: string }).purpose).toBe(START_SWAP_PURPOSE_V2);
    expect((starts[0]!.message as { salt: string }).salt).toBe(salt);
  });

  it('the session never keeps the seed (F-A14): only the wallet module holds the keys', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const s = track(SwapSession.begin(offer, deps(signer, new FakeSepolia(signer.address))));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    const seed = swapSeedFromSignature(signer.signatures[0]!);
    const found: string[] = [];
    const scan = (v: unknown, path: string, depth: number, seen: Set<unknown>) => {
      if (typeof v === 'string') {
        if (v.includes(seed)) found.push(path);
        return;
      }
      if (!v || typeof v !== 'object' || depth > 4 || seen.has(v)) return;
      seen.add(v);
      for (const k of Object.getOwnPropertyNames(v)) {
        if (k === 'deps') continue; // the ports, not the session's own state
        scan((v as Record<string, unknown>)[k], `${path}.${k}`, depth + 1, seen);
      }
    };
    scan(s, 'session', 0, new Set());
    expect(found).toEqual([]);
    expect(s.hasSecrets()).toBe(true); // the token, and the wallet (its keys inside the module)
    await s.close();
    expect(s.hasSecrets()).toBe(false);
  });
});

describe('P4.2-fix change 4: /prove answers 409 stale-vault-state', () => {
  it('the withdrawal draft is released, rebuilt and proven again', async () => {
    env = mockEnv();
    const offer = await askOffer(env);
    const signer = testSigner();
    const d = deps(signer, new FakeSepolia(signer.address));
    let stale = 0;
    const real = env.sponsorFetch;
    const staleOnce = async (url: string, init: RequestInit = {}) => {
      if (url.endsWith('/prove') && String(init.body).includes('"withdraw"') && stale++ === 0)
        return new Response(JSON.stringify({ error: { code: 'stale-vault-state', message: 'the vault moved on' } }), {
          status: 409,
        });
      return real(url, init);
    };
    const { HttpSponsorApi } = await import('../src/swap/sponsor-client.js');
    d.backends = { ...d.backends, sponsor: new HttpSponsorApi('https://sponsor.mock.invalid', { fetch: staleOnce }) };
    const s = track(SwapSession.begin(offer, d));
    await waitFor(() => statusOf(s).kind === 'fund', 5_000);
    await s.sendFunds();
    await waitFor(() => statusOf(s).kind === 'done', 10_000, 'the swap after a stale proof');
    expect(env.controls.walletStats()).toEqual({ drafts: 3, released: 1 });
  });
});

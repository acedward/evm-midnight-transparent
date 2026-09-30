// The swap session (web/src/swap/session.ts) against the mock ports: every stage of a swap, the
// determinism warning, "Swap is not available" + Bridge back, a refunded withdrawal retried, resume
// after the tab closed, and the page's refusals (a deposit address it did not compute, an offer that
// is gone, not enough funds). The records it writes hold no secret and survive Export/Import.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { transferData } from '../src/swap/evm.js';
import type { MockEnvironment } from '../src/swap/mock/index.js';
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

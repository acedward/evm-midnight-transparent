// Plan 00048 P4.5 (a), found live in P4.2-live E.5: while the sponsor was paused, its gateway answered
// 502 and the swap page showed "The swap stopped. the sponsor answered 502" with Retry. A passing
// sponsor outage (a gateway's 502/503/504, a sponsor's coded 5xx "try again", no answer at all, a
// timeout) while the page polls the swap or calls it for the take and the withdrawal must NOT stop the
// swap: the page keeps waiting, with a growing wait and a quiet "The sponsor is not answering; still
// trying" notice, and goes on by itself when the sponsor answers again. Only a definitive refusal (a
// 4xx with a code) stops it, and every existing stop stays: a session the sponsor no longer knows (401
// or 404), and an answer the page cannot read, ten times in a row.

import { SponsorApiError } from '@evm-midnight-transparent/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MockEnvironment, SponsorDownAnswer } from '../src/swap/mock/index.js';
import { saveSwapRecord } from '../src/swap/records.js';
import * as sessionModule from '../src/swap/session.js';
import { type SessionDeps, type SessionStatus, SwapSession } from '../src/swap/session.js';
import { LocalStore } from '../src/store/store.js';
import { FakeSepolia, askOffer, backendsOf, mockEnv, network, registry, testSigner, waitFor } from './swap-fixtures.js';

const OUTAGE = 'The sponsor is not answering; still trying.';

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

const statusOf = (s: SwapSession) => s.getSnapshot().status;
const outageOf = (s: SwapSession) => (s.getSnapshot() as { outage?: string | null }).outage ?? null;
const stateOf = () => (env.controls.views()[0] as { state?: string } | undefined)?.state;
const down = (answer: SponsorDownAnswer | null, only?: string) => env.controls.setSponsorDown(answer, only);
const hits = () => env.controls.sponsorDownHits();

/** Every status and outage notice the session showed, in order. */
function watch(s: SwapSession) {
  const statuses: SessionStatus[] = [];
  const outages: string[] = [];
  s.subscribe(() => {
    const snap = s.getSnapshot();
    if (statuses.at(-1) !== snap.status) statuses.push(snap.status);
    const o = outageOf(s);
    if (o && outages.at(-1) !== o) outages.push(o);
  });
  return {
    statuses,
    outages,
    errors: () => statuses.filter((x) => x.kind === 'error'),
  };
}

/** A swap of the mock book's ask offer, funded; `sleep` replaces the session's waits when given. */
async function fundedSwap(opts: { stepMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  env = mockEnv({ stepMs: opts.stepMs ?? 30 });
  const offer = await askOffer(env);
  const signer = testSigner();
  const evm = new FakeSepolia(signer.address);
  env.setEvmReader(evm);
  const deps: SessionDeps = {
    backends: backendsOf(env, opts.pollMs ?? 5),
    network,
    registry,
    signer,
    evm,
    save: (r) => saveSwapRecord(store, r),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
  };
  const s = SwapSession.begin(offer, deps);
  sessions.push(s);
  const w = watch(s);
  await waitFor(() => statusOf(s).kind === 'fund', 5_000, 'the funding step');
  await s.sendFunds();
  return { s, w };
}

/** Wait until the sponsor refused `n` more requests while down, or the swap stopped (the bug). */
async function refusedAtLeast(s: SwapSession, n: number, what: string): Promise<void> {
  const from = hits();
  await waitFor(() => hits() - from >= n || statusOf(s).kind === 'error', 20_000, what);
}

describe('P4.5: a passing sponsor outage never stops the swap', () => {
  it('the classification: no answer, a timeout, 408, 429 and every 5xx pass; a 4xx with a code and an unreadable answer do not', () => {
    const e = (status: number, code: string) => new SponsorApiError(status, code, 'x');
    for (const t of [
      e(0, 'network'),
      e(408, 'http'),
      e(429, 'rate-limited'),
      e(500, 'internal-error'),
      e(502, 'http'),
      e(503, 'prover-unavailable'),
      e(504, 'http-504'),
    ])
      expect((t as { transient?: boolean }).transient, `${t.status} ${t.code}`).toBe(true);
    for (const t of [
      e(0, 'bad-request'),
      e(200, 'invalid-response'),
      e(400, 'bad-request'),
      e(401, 'unauthorised'),
      e(404, 'not-found'),
      e(409, 'stale-vault-state'),
      e(422, 'invalid-tx'),
    ])
      expect((t as { transient?: boolean }).transient, `${t.status} ${t.code}`).toBe(false);
  });

  it('polling: a 502, then no answer, then a 504, far past the old ten misses, mid bridge-in: waits, says so quietly, and completes by itself', async () => {
    const { s, w } = await fundedSwap();
    await waitFor(() => stateOf() === 'depositing', 10_000, 'the bridge-in');

    down(502);
    await refusedAtLeast(s, 12, 'twelve 502s');
    expect(w.errors(), 'a 502 while polling is not a stop').toEqual([]);
    expect(outageOf(s)).toBe(OUTAGE);
    down('network');
    await refusedAtLeast(s, 4, 'four network errors');
    down(504);
    await refusedAtLeast(s, 3, 'three 504s');
    expect(w.errors(), 'no answer or a 504 while polling is not a stop').toEqual([]);
    expect(statusOf(s).kind).toBe('working');
    // The sponsor's clock stood still: nothing moved while it was down.
    expect(stateOf()).toBe('depositing');

    down(null);
    await waitFor(() => statusOf(s).kind === 'done' || statusOf(s).kind === 'error', 20_000, 'the swap to finish');
    expect(w.errors()).toEqual([]);
    expect(statusOf(s).kind).toBe('done');
    expect(s.getSnapshot().record).toMatchObject({ phase: 'done', outcome: 'swapped' });
    // The notice was quiet and went away once the sponsor answered again.
    expect(w.outages).toEqual([OUTAGE]);
    expect(outageOf(s)).toBeNull();
    expect(s.getSnapshot().notice ?? '').not.toMatch(/did not answer/);
  });

  it('the take and the withdrawal: /prove 503 "try again", withdraw-params unreachable, /withdraw 502: each waited out, every unsent draft released, the swap completes', async () => {
    const { s, w } = await fundedSwap();

    // The sponsor's own coded "try again" while it proves the take (the old page stopped at the first).
    down({ status: 503, code: 'prover-unavailable', message: 'the proof server is not available' }, '/prove');
    await refusedAtLeast(s, 4, 'the take refused four times');
    expect(w.errors(), 'a 503 on /prove is not a stop').toEqual([]);
    expect(outageOf(s)).toBe('The sponsor cannot go on right now (the proof server is not available); still trying.');
    expect(env.chain.balances(s.getSnapshot().record!.temp.coinPk).size).toBe(1); // nothing taken yet

    down('network', '/withdraw-params');
    await refusedAtLeast(s, 3, 'withdraw-params unreachable three times');
    expect(s.getSnapshot().record?.take.landed).toBe(true);
    expect(w.errors(), 'no answer on withdraw-params is not a stop').toEqual([]);
    expect(outageOf(s)).toBe(OUTAGE);

    down(502, '/withdraw');
    await refusedAtLeast(s, 3, 'the withdrawal refused three times by the gateway');
    expect(w.errors(), 'a 502 on /withdraw is not a stop').toEqual([]);

    down(null);
    await waitFor(() => statusOf(s).kind === 'done' || statusOf(s).kind === 'error', 20_000, 'the swap to finish');
    expect(w.errors()).toEqual([]);
    expect(s.getSnapshot().record).toMatchObject({ phase: 'done', outcome: 'swapped' });
    expect(outageOf(s)).toBeNull();
    // Exactly one take and one withdrawal were submitted; every other draft was released.
    const stats = env.controls.walletStats();
    expect(stats.drafts - stats.released).toBe(2);
    expect(stats.released).toBeGreaterThanOrEqual(4 + 3);
    // One withdrawal reached the sponsor, after the outage.
    expect(env.sponsor.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/withdraw'))).toHaveLength(1);
  });

  it('the wait grows while the sponsor is down (10 s, 20 s, 40 s, then at most a minute, live) and is the poll interval again once it answers', async () => {
    const sleeps: number[] = [];
    const { s, w } = await fundedSwap({
      pollMs: 5_000,
      // The live poll interval, with the waits recorded and made short.
      sleep: (ms) => {
        sleeps.push(ms);
        return new Promise((r) => setTimeout(r, 2));
      },
    });
    await waitFor(() => stateOf() === 'depositing', 10_000, 'the bridge-in');
    const from = sleeps.length;
    down(503);
    await refusedAtLeast(s, 7, 'seven 503s');
    const during = sleeps.slice(from);
    down(null);
    await waitFor(() => statusOf(s).kind === 'done' || statusOf(s).kind === 'error', 20_000, 'the swap to finish');
    expect(w.errors()).toEqual([]);
    // The polls before the outage, then the growing waits (one per refused poll), capped at a minute.
    const firstLong = during.findIndex((ms) => ms > 5_000);
    expect(during.slice(0, firstLong).every((ms) => ms === 5_000)).toBe(true);
    expect(during.slice(firstLong, firstLong + 6)).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    expect(Math.max(...sleeps)).toBe(60_000);
    expect((sessionModule as { MAX_OUTAGE_WAIT_MS?: number }).MAX_OUTAGE_WAIT_MS).toBe(60_000);
    // Back up: the poll interval again.
    expect(sleeps.at(-1)).toBe(5_000);
  });
});

describe('P4.5: every existing stop stays', () => {
  it('a session the sponsor no longer knows (401) stops at once, without Retry', async () => {
    const { s, w } = await fundedSwap();
    await waitFor(() => stateOf() === 'depositing', 10_000, 'the bridge-in');
    down({ status: 401, code: 'unauthorised', message: 'the swap token is missing or wrong' });
    await waitFor(() => statusOf(s).kind === 'error', 10_000, 'the stop');
    expect(statusOf(s)).toMatchObject({ kind: 'error', canRetry: false, message: /no longer recognises this session/ });
    expect(hits()).toBe(1);
    expect(w.outages).toEqual([]);
  });

  it('a definitive refusal of the take (422 with a code) stops the swap with Retry, as before', async () => {
    const { s, w } = await fundedSwap();
    down({ status: 422, code: 'invalid-tx', message: 'the transaction is not this swap’s take' }, '/prove');
    await waitFor(() => statusOf(s).kind === 'error', 10_000, 'the stop');
    expect(statusOf(s)).toMatchObject({
      kind: 'error',
      canRetry: true,
      message: 'the transaction is not this swap’s take',
    });
    expect(hits()).toBe(1);
    expect(w.outages).toEqual([]);
    // Nothing was taken, and the draft was released.
    const stats = env.controls.walletStats();
    expect(stats.drafts).toBe(1);
    expect(stats.released).toBe(1);
  });

  it('an answer the page cannot read (a 200 that is not the sponsor’s) still stops after ten in a row, with Retry', async () => {
    const { s, w } = await fundedSwap();
    await waitFor(() => stateOf() === 'depositing', 10_000, 'the bridge-in');
    down(200);
    await waitFor(() => statusOf(s).kind === 'error', 10_000, 'the stop');
    expect(statusOf(s)).toMatchObject({ kind: 'error', canRetry: true });
    expect(hits()).toBe(10);
    expect(w.outages).toEqual([]);
  });
});

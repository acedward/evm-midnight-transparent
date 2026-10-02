// The swap state machine's transitions, the JSON store (it survives a restart, holds no secret),
// the service resuming swaps in flight after a restart, the stale closer, and the sweep sizing.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SWAP_PATHS, SWAP_STATES, type SwapState } from '@evm-midnight-transparent/core';
import { afterEach, describe, expect, it } from 'vitest';

import { TRANSITIONS, TransitionError, canTransition, transition, type SwapRecord } from '../src/swaps/model.js';
import { StaleCloser } from '../src/swaps/stale.js';
import { JsonFileSwapStore, StoreError } from '../src/swaps/store.js';
import {
  DEFAULT_SWEEP_GAS_LIMITS,
  MEASURED_WORST_GAS,
  parseSweepGasLimits,
  sizeSweepGas,
} from '../src/swaps/sweep-gas.js';
import { FakeVault, VAULT_EVM, gate } from './fakes.js';
import { bidSwap, fund, harness, openSwap, silentLog, tok, type Harness } from './harness.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'emt-swaps-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the state machine', () => {
  it('allows exactly the documented transitions', () => {
    const allowed = Object.entries(TRANSITIONS).flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`));
    expect(allowed.sort()).toEqual(
      [
        'awaiting_funds->depositing',
        'awaiting_funds->partial',
        'awaiting_funds->minted',
        'awaiting_funds->failed',
        'depositing->minted',
        'depositing->partial',
        'depositing->awaiting_funds',
        'depositing->failed',
        // A partial deposit (audit S2): the remainder, or a Bridge back of what arrived; failed when
        // everything was lost to other parties' settles (audit T1).
        'partial->depositing',
        'partial->failed',
        'partial->minted',
        'partial->bridging_back',
        'minted->taking',
        'minted->taken',
        'minted->withdrawing',
        'minted->bridging_back',
        'minted->failed',
        'taking->taken',
        'taking->minted',
        'taking->withdrawing',
        'taking->bridging_back',
        'taking->failed',
        'taken->withdrawing',
        'taken->bridging_back',
        'taken->minted',
        'taken->failed',
        'withdrawing->done',
        'withdrawing->minted',
        'withdrawing->failed',
        'bridging_back->done',
        'bridging_back->minted',
        'bridging_back->partial',
        'bridging_back->failed',
        'failed->awaiting_funds',
        'failed->partial',
      ].sort(),
    );
  });

  it('refuses everything else, and done is final', () => {
    for (const from of SWAP_STATES) {
      for (const to of SWAP_STATES) {
        expect(canTransition(from, to)).toBe(TRANSITIONS[from].includes(to));
      }
    }
    expect(TRANSITIONS.done).toEqual([]);
    const rec = { state: 'taken' as SwapState, history: [], updatedAt: 0 } as unknown as SwapRecord;
    expect(() => transition(rec, 'awaiting_funds', 1)).toThrow(TransitionError);
    expect(() => transition(rec, 'depositing', 1)).toThrow(TransitionError);
    expect(() => transition(rec, 'done', 1)).toThrow(TransitionError);
    transition(rec, 'failed', 2, { reason: 'x', message: 'y', recoverable: true });
    expect(rec).toMatchObject({ state: 'failed', reason: 'x', message: 'y', updatedAt: 2, recoverable: true });
    expect(rec.history).toEqual([{ state: 'failed', at: 2 }]);
    transition(rec, 'awaiting_funds', 3);
    expect(rec.recoverable).toBeUndefined();
    expect(rec.reason).toBeUndefined();
  });
});

describe('the JSON store', () => {
  it('survives a restart, is written with mode 600, and holds no bearer token', async () => {
    const dir = tmp();
    const h = harness({ store: new JsonFileSwapStore(dir) });
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    const file = join(dir, 'swaps.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toContain(o.swapToken);
    expect(text).toContain(s.swapId);
    expect(text).not.toMatch(/"(seed|secret|mnemonic|privateKey|token)"/i);
    // a new process over the same directory sees the swap, and the old token still works there
    const again = harness({ store: new JsonFileSwapStore(dir) });
    expect(again.store.get(s.swapId)!.state).toBe('awaiting_funds');
    expect(
      (await again.app.request(SWAP_PATHS.swap(s.swapId), { headers: { authorization: `Bearer ${o.swapToken}` } }))
        .status,
    ).toBe(200);
  });

  it('refuses to start over a corrupt file, and prunes only finished swaps past the retention', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'swaps.json'), '{nope');
    expect(() => new JsonFileSwapStore(dir)).toThrow(StoreError);
    const d2 = tmp();
    const store = new JsonFileSwapStore(d2, 1);
    const h = harness({ store });
    const s = bidSwap(h);
    await openSwap(h, s);
    const rec = store.get(s.swapId)!;
    expect(store.prune(rec.updatedAt + 10 * 86_400)).toBe(0); // in flight: never dropped
    transition(rec, 'failed', rec.updatedAt, { reason: 'x', message: 'y' });
    store.put(rec);
    expect(store.prune(rec.updatedAt + 2 * 86_400)).toBe(1);
    expect(new JsonFileSwapStore(d2).all()).toHaveLength(0);
  });
});

describe('restarts: the service resumes every swap in flight from its recorded request', () => {
  async function prepare(h: Harness) {
    h.vault.evm.nonces.set(VAULT_EVM.toLowerCase(), { latest: 9n, pending: 9n });
    h.vault.evm.setEth(VAULT_EVM, 10n ** 17n);
    h.vault.evm.setErc20(tok('USDC').sepoliaAddress, VAULT_EVM, 10n ** 12n);
  }

  it('a deposit interrupted after its start (relay pending) resumes and mints, without a second start', async () => {
    const dir = tmp();
    const vault = new FakeVault();
    const h1 = harness({ store: new JsonFileSwapStore(dir), vault });
    await prepare(h1);
    const s = bidSwap(h1);
    const o = await openSwap(h1, s);
    fund(h1, o);
    const hold = gate();
    vault.defaultRelay = { beforeBroadcast: hold.promise };
    await h1.swaps.pollDeposits();
    await new Promise((r) => setTimeout(r, 20));
    expect(new JsonFileSwapStore(dir).get(s.swapId)!.deposit!.requestId).toBeDefined();
    // "restart": a new service over the same directory; the old one never finishes
    vault.defaultRelay = {};
    const h2 = harness({ store: new JsonFileSwapStore(dir), vault, offers: h1.offers });
    h2.swaps.start();
    h2.swaps.stop();
    await h2.swaps.idle();
    const rec = h2.store.get(s.swapId)!;
    expect(rec.state).toBe('minted');
    expect(vault.log.filter((l) => l.startsWith('startDeposit'))).toHaveLength(1);
    expect(rec.deposit!.stages.some((x) => x.stage === 'completed')).toBe(true);
    hold.open();
    await h1.swaps.idle();
  });

  it('a withdrawal interrupted after its start resumes: relay, completeWithdraw, done', async () => {
    const dir = tmp();
    const vault = new FakeVault();
    const h1 = harness({ store: new JsonFileSwapStore(dir), vault });
    await prepare(h1);
    const s = bidSwap(h1);
    const o = await openSwap(h1, s);
    fund(h1, o);
    await h1.swaps.pollDeposits();
    await h1.swaps.idle();
    const rec = h1.store.get(s.swapId)!;
    // the start landed and was recorded, then the process died
    transition(rec, 'withdrawing', rec.updatedAt);
    // (the request as the vault holds it after the start)
    const requestId = 'ab'.repeat(32);
    vault.requests.set(requestId, {
      kind: 'withdraw',
      id: requestId,
      path: 'vault',
      evmNonce: 9n,
      signer: VAULT_EVM,
      erc20: tok('USDC').sepoliaAddress,
      amount: 1_000_000n,
      gasLimit: 100_000n,
      maxFeePerGas: 10_000_000_000n,
    });
    rec.withdrawals.push({
      kind: 'swap',
      colour: tok('USDC').midnightColour,
      amount: '1000000',
      stage: 'started',
      stages: [{ stage: 'started', at: rec.updatedAt }],
      refunds: 0,
      evmNonce: '9',
      coinNonce: 'cd'.repeat(32),
      requestId,
      startTx: 'ef'.repeat(32),
    });
    h1.store.put(rec);
    const h2 = harness({ store: new JsonFileSwapStore(dir), vault, offers: h1.offers });
    h2.swaps.start();
    h2.swaps.stop();
    await h2.swaps.idle();
    const after = h2.store.get(s.swapId)!;
    expect(after).toMatchObject({ state: 'done', outcome: 'swapped' });
    expect(vault.settles.at(-1)).toMatchObject({ circuit: 'completeWithdraw', requestId });
  });

  it('a withdrawal recorded before its start was confirmed, whose request never appeared: back to minted', async () => {
    const h = harness();
    await prepare(h);
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    transition(rec, 'bridging_back', rec.updatedAt);
    rec.withdrawals.push({
      kind: 'bridge-back',
      colour: rec.pay.colour,
      amount: rec.pay.amount,
      stage: 'submitting',
      stages: [],
      refunds: 0,
      evmNonce: '9',
      coinNonce: 'cd'.repeat(32),
      requestId: '99'.repeat(32),
    });
    h.store.put(rec);
    // P4.2-fix2 (audit R5): a request not seen yet may be a lagging read: the attempt keeps its nonce
    // until the window shows it did not land.
    await h.swaps.resumeWithdraw(s.swapId);
    expect(h.store.get(s.swapId)!.state).toBe('bridging_back');
    expect(h.store.get(s.swapId)!.withdrawals.at(-1)!.stage).toBe('submission-uncertain');
    h.now.ms += 16 * 60_000;
    await h.swaps.resumeWithdraw(s.swapId);
    expect(h.store.get(s.swapId)!.state).toBe('minted');
    expect(h.store.get(s.swapId)!.withdrawals.at(-1)!.error!.code).toBe('not-included');
  });
});

describe('the stale closer (the sponsor’s own requests only)', () => {
  it('drives a stalled deposit again after staleAfter, within the daily cap and the DUST reserve', async () => {
    const h = harness();
    const s = bidSwap(h);
    const o = await openSwap(h, s);
    fund(h, o);
    h.vault.defaultRelay = { fail: "timed out after 1200 s waiting for the MPC's signature on x (expected signer y)" };
    await h.swaps.pollDeposits();
    await h.swaps.idle();
    const rec = h.store.get(s.swapId)!;
    expect(rec.state).toBe('depositing');
    expect(rec.deposit!.stage).toBe('relay-stalled');
    expect(h.swaps.mpcStatus().timeouts24h).toBe(1);
    h.vault.defaultRelay = {};
    const sponsor = { current: h.sponsor.current };
    const closer = new StaleCloser({
      config: {
        enabled: true,
        intervalMs: 1000,
        staleAfterMs: 15 * 60_000,
        maxPerDay: 1,
        minSponsorDustSpecks: 10n ** 16n,
      },
      service: h.swaps,
      sponsor: () => sponsor.current,
      log: silentLog(),
      now: () => h.now.ms,
    });
    // not stale yet
    await closer.scan();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('depositing');
    // stale, but the sponsor is under the reserve
    h.now.ms += 16 * 60_000;
    sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 10n ** 15n };
    await closer.scan();
    expect(closer.status().paused).toMatch(/reserve/);
    sponsor.current = { configured: true, state: 'synced', synced: true, dustSpecks: 10n ** 20n };
    await closer.scan();
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!.state).toBe('minted');
    expect(closer.status()).toMatchObject({ closed24h: 1, paused: null });
    expect(h.vault.log.filter((l) => l.startsWith('startDeposit'))).toHaveLength(1);
  });

  it('never touches swaps that are not in flight', async () => {
    const h = harness();
    const s = bidSwap(h);
    await openSwap(h, s);
    h.now.ms += 3600_000;
    expect(h.swaps.stalled(Math.floor(h.now.ms / 1000))).toHaveLength(0);
  });
});

describe('sweep gas sizing (G-BRIDGE formula, per token)', () => {
  it('reproduces the G-BRIDGE run: base fee 0.952 gwei -> 2.5 gwei, 65,000 gas, 0.0001625 ETH', () => {
    expect(sizeSweepGas('stkA', 952_000_000n)).toEqual({
      gasLimit: 65_000n,
      maxFeePerGas: 2_500_000_000n,
      maxPriorityFeePerGas: 500_000_000n,
      ethWei: 162_500_000_000_000n,
    });
    expect(sizeSweepGas('USDC', 0n).maxFeePerGas).toBe(500_000_000n);
    expect(sizeSweepGas('stkA', 1n).maxFeePerGas).toBe(600_000_000n);
  });

  it('keeps every token’s limit at least 20% above its worst measured transfer, and knows all 8 tokens', () => {
    for (const [symbol, worst] of Object.entries(MEASURED_WORST_GAS)) {
      expect(DEFAULT_SWEEP_GAS_LIMITS[symbol]! * 100n).toBeGreaterThanOrEqual(worst * 120n);
    }
    expect(Object.keys(DEFAULT_SWEEP_GAS_LIMITS).sort()).toEqual(
      ['stkA', 'stkB', 'stkC', 'USDC', 'TBILL', 'TB13W', 'TB26W', 'TB52W'].sort(),
    );
  });

  it('takes per-symbol overrides and refuses nonsense', () => {
    expect(parseSweepGasLimits('USDC:70000, stkA:60000')).toMatchObject({
      USDC: 70_000n,
      stkA: 60_000n,
      stkB: 65_000n,
    });
    expect(() => parseSweepGasLimits('USDC=70000')).toThrow();
    expect(() => parseSweepGasLimits('USDC:10000')).toThrow();
    expect(() => parseSweepGasLimits('USDC:9000000')).toThrow();
  });

  it('refuses to open a swap during a gas spike (the sweep ETH over SWEEP_MAX_WEI)', async () => {
    const h = harness();
    h.vault.evm.baseFee = 10n ** 14n; // 100,000 gwei
    const s = bidSwap(h);
    await expect(openSwap(h, s)).rejects.toThrow(/503/);
  });
});

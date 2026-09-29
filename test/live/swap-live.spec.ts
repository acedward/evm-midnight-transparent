// Plan 00048 P3: LIVE end-to-end runs through the REAL UI of the deployed bundle (deploy/compose.yml),
// on Midnight stagenet and Sepolia, within the Q8 caps. One phase per run (LIVE_PHASE):
//
//   e2   E.2 + E.4: the full swap of LIVE_OFFER_ID. Start (the "start swap" message signed twice, the
//        sponsor's open-swap once), the two Sepolia transactions from the page, and DURING the
//        bridge-in the page is closed; a new page resumes it (one signature, the coin key checked,
//        a re-open for a new token) and finishes it: take through the batcher, bridge out, done.
//   e3   E.3: start a swap of LIVE_OFFER_ID and fund it; once the bridge-in has started the spec writes
//        LIVE_STATE_DIR/e3-ready.json, and the operator takes the offer with a competitor wallet
//        (test/gates/take, run-live.sh competitor-take). The page must show "Swap is not
//        available"; Bridge back must return the exact bridged amount to the user's address.
//
// The test EVM user's key (`.sepolia`, SK=) is read by THIS process from a read-only mount and stays
// here: the page only sees an EIP-1193 provider (test/e2e/test-wallet.ts, LIVE mode) that signs and
// broadcasts on Sepolia. Nothing secret is logged, written or screenshotted. The swap's temporary
// Midnight key lives in the page's memory only. Evidence (public values: addresses, hashes, amounts,
// timings, screenshots) goes to LIVE_OUT_DIR.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { Contract, Interface, JsonRpcProvider } from 'ethers';

import { connect, typedDataCalls } from '../e2e/fixtures.js';
import { type TestWallet, installTestWallet } from '../e2e/test-wallet.js';
import { readSepoliaKey } from './sepolia-key.js';

const PHASE = process.env.LIVE_PHASE ?? '';
const OFFER = (process.env.LIVE_OFFER_ID ?? '').toLowerCase();
const OUT = process.env.LIVE_OUT_DIR ?? '';
const STATE_DIR = process.env.LIVE_STATE_DIR ?? '';
const KEY_FILE = process.env.LIVE_KEY_FILE ?? '/secrets/sepolia';
/** e2: continue a swap already opened (its public record, an export file) instead of starting one. */
const IMPORT_FILE = process.env.LIVE_IMPORT_FILE ?? '';
const RPC = process.env.LIVE_SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com';
const INDEXER = 'https://indexer.stagenet.shielded.tools/api/v4/graphql';
const KERNEL = 'https://stagenet.api-zswap.zkdojo.com';
const USER = '0x484738A67858305Edfc139B194Ed430Fe4D8e56b';
const VAULT_EVM = '0x648216975e722494bFF92E88FFc68C8F8d438FaA';
const MIN = 60_000;

test.skip(!PHASE || !OFFER || !OUT || !STATE_DIR, 'needs the deployed bundle and the live-run files (run-live.sh)');
test.setTimeout(150 * MIN);

// ── helpers ─────────────────────────────────────────────────────────────────────────

/** The test user's key (in-process only, never printed). */
const userKey = () => readSepoliaKey(KEY_FILE);

const sepolia = () => new JsonRpcProvider(RPC, 11155111, { staticNetwork: true });
const ERC20 = [
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const since = (t: number) => Math.round((Date.now() - t) / 100) / 10;

async function balances(tokens: Record<string, string>): Promise<Record<string, string>> {
  const p = sepolia();
  const out: Record<string, string> = {
    ETH: (await p.getBalance(USER)).toString(),
    vaultEvmETH: (await p.getBalance(VAULT_EVM)).toString(),
  };
  for (const [sym, addr] of Object.entries(tokens)) {
    out[sym] = ((await new Contract(addr, ERC20, p).getFunction('balanceOf')(USER)) as bigint).toString();
  }
  return out;
}

/** The ERC20 transfers and the status of a Sepolia transaction (public). */
async function sepoliaTx(hash: string) {
  const r = await sepolia().getTransactionReceipt(hash);
  if (!r) return { hash, status: null };
  const iface = new Interface(ERC20);
  const transfers = r.logs.flatMap((l) => {
    try {
      const e = iface.parseLog(l);
      return e && e.name === 'Transfer'
        ? [
            {
              token: l.address,
              from: String(e.args[0]),
              to: String(e.args[1]),
              value: (e.args[2] as bigint).toString(),
            },
          ]
        : [];
    } catch {
      return [];
    }
  });
  return {
    hash,
    status: r.status,
    block: r.blockNumber,
    from: r.from,
    to: r.to,
    gasUsed: r.gasUsed.toString(),
    gasPrice: r.gasPrice.toString(),
    transfers,
  };
}

async function getJson<T = Record<string, unknown>>(url: string): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}

/** The sponsor's public health, through the bundle's same-origin proxy. */
const health = (baseURL: string) => getJson(`${baseURL}/sponsor/v1/health`);

/** A Midnight transaction's fee and block (the indexer; public). */
async function midnightTx(hash: string | undefined): Promise<Record<string, unknown> | null> {
  if (!hash) return null;
  try {
    const r = await fetch(INDEXER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: `query($h: HexEncoded!) { transactions(offset: { hash: $h }) { hash block { height timestamp } ... on RegularTransaction { fee transactionResult { status } } } }`,
        variables: { h: hash.replace(/^0x/, '') },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await r.json()) as { data?: { transactions?: unknown[] }; errors?: unknown };
    return { hash, found: j.data?.transactions?.[0] ?? null, ...(j.errors ? { errors: j.errors } : {}) };
  } catch (e) {
    return { hash, error: e instanceof Error ? e.message : String(e) };
  }
}

async function evidence(name: string, body: Record<string, unknown>) {
  await mkdir(OUT, { recursive: true });
  await writeFile(
    join(OUT, `${name}.json`),
    `${JSON.stringify({ plan: '00048 P3', phase: PHASE, ...body, writtenUtc: new Date().toISOString() }, null, 2)}\n`,
  );
}

async function shot(page: Page, name: string) {
  await mkdir(OUT, { recursive: true });
  await page.evaluate(() => document.fonts.ready).catch(() => undefined);
  await page.screenshot({ path: join(OUT, `shot-${PHASE}-${name}.png`), fullPage: true });
}

/** This context's swap record (public: the page never stores a secret). */
async function swapRecord(page: Page, swapId?: string): Promise<Record<string, unknown> | null> {
  const all = await page.evaluate(() =>
    Object.entries({ ...localStorage })
      .filter(([k]) => k.startsWith('evm-midnight-transparent/') && k.includes('/swap/'))
      .map(([, v]) => v),
  );
  const recs = all
    .map((v) => (JSON.parse(v) as { data?: Record<string, unknown> }).data)
    .filter((r): r is Record<string, unknown> => !!r);
  return (swapId ? recs.find((r) => r.swapId === swapId) : recs[0]) ?? null;
}

/** Every localStorage value of the site, for the no-secret check. */
const storedText = (page: Page) =>
  page.evaluate(() =>
    Object.entries({ ...localStorage })
      .filter(([k]) => k.startsWith('evm-midnight-transparent/'))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );

const phaseOf = (page: Page) => page.getByTestId('swap-page').getAttribute('data-phase');

/** Wait until the swap page's phase is one of `phases`; returns it. Screens and records any error. */
async function waitPhase(page: Page, phases: string[], timeoutMs: number, label: string): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const p = (await phaseOf(page).catch(() => null)) ?? '';
    if (p !== last) {
      console.log(`[${new Date().toISOString()}] ${label}: phase ${p}`);
      last = p;
    }
    if (phases.includes(p)) return p;
    const status = await page
      .getByTestId('swap-page')
      .getAttribute('data-status')
      .catch(() => null);
    if (status === 'error') {
      const msg = await page
        .getByTestId('swap-error')
        .innerText()
        .catch(() => '');
      await shot(page, `error-${label}`);
      throw new Error(`the swap page shows an error while waiting for ${phases.join('|')}: ${msg}`);
    }
    await page.waitForTimeout(5_000);
  }
  await shot(page, `timeout-${label}`);
  throw new Error(`timed out waiting for ${phases.join('|')} (last phase ${last})`);
}

/** Wait until the bridge-in's stages list names `stage` (the sponsor's stage id, as its title). */
async function waitBridgeInStage(page: Page, title: RegExp, timeoutMs: number) {
  await expect(page.getByTestId('bridge-in-stages')).toContainText(title, { timeout: timeoutMs });
}

async function openOffer(page: Page, w: TestWallet) {
  await page.goto('/#swap');
  await connect(page);
  expect(w.address).toBe(USER);
  await expect(page.getByTestId('feed-status')).toHaveAttribute('data-status', 'ready', { timeout: 2 * MIN });
  const row = page.locator(`[data-testid=offer-row][data-offer-id="${OFFER}"]`);
  await expect(row, `offer ${OFFER} is listed`).toBeVisible({ timeout: 2 * MIN });
  return row;
}

/** Start the swap of OFFER through the page, up to the funding step. */
async function startSwap(page: Page, w: TestWallet, times: Record<string, number>, t0: number) {
  const row = await openOffer(page, w);
  await shot(page, '01-offers');
  const listed = {
    pay: await row.getByTestId('offer-pay').innerText(),
    receive: await row.getByTestId('offer-receive').innerText(),
    price: await row.getByTestId('offer-price').innerText(),
    expires: await row.getByTestId('offer-expires').innerText(),
  };
  await row.getByTestId('offer-swap').click();
  await expect(page.getByTestId('review-swap')).toBeVisible();
  await shot(page, '02-review');
  times.startClicked = since(t0);
  await page.getByTestId('start-swap').click();
  await expect(page.getByTestId('send-funds')).toBeVisible({ timeout: 5 * MIN });
  times.fundReady = since(t0);
  const signed = typedDataCalls(w);
  expect(signed.map((t) => t.primaryType)).toEqual(['StartSwap', 'StartSwap', 'SponsorAction']);
  expect(signed[0]).toEqual(signed[1]);
  await expect(page.getByTestId('recoverable')).toBeVisible();
  const deposit = (await page.getByTestId('deposit-address').getAttribute('data-value'))!;
  const temp = (await page.getByTestId('temp-address').getAttribute('data-value'))!;
  await shot(page, '03-fund');
  const rec = await swapRecord(page);
  expect(rec, 'the swap record').not.toBeNull();
  return { listed, deposit, temp, record: rec! };
}

/** Import a swap's record (Local data → Import, FR-007) and resume it from Your swaps: the "start
 *  swap" message signed once (the coin key must match), then the sponsor's re-open. */
async function importAndResume(page: Page, w: TestWallet, times: Record<string, number>, t0: number) {
  const text = readFileSync(IMPORT_FILE, 'utf8');
  const file = JSON.parse(text) as { records: Array<{ value: { data: Record<string, unknown> } }> };
  const swapId = String(file.records[0]!.value.data.swapId);
  await page.goto('/#swap');
  await connect(page);
  await page.goto('/#local');
  await page.getByTestId('import-file').setInputFiles({
    name: 'swap-record.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text),
  });
  await expect(page.getByTestId('local-message')).toContainText('Imported 1 records');
  await shot(page, '00-imported');
  await page.goto('/#swap');
  const row = page.locator(`[data-testid=swap-record][data-swap-id="${swapId}"]`);
  await expect(row).toBeVisible({ timeout: 2 * MIN });
  await expect(row).toHaveAttribute('data-phase', 'funding');
  times.resumeAtFundingClicked = since(t0);
  await row.getByTestId('record-resume').click();
  await expect(page.getByTestId('send-funds')).toBeVisible({ timeout: 5 * MIN });
  times.fundReady = since(t0);
  expect(typedDataCalls(w).map((t) => t.primaryType)).toEqual(['StartSwap', 'SponsorAction']);
  await shot(page, '03-fund');
  return { swapId, record: (await swapRecord(page, swapId))! };
}

/** "Send funds": the sweep ETH (unless the deposit address has it), then exactly the pay amount, both
 *  broadcast on Sepolia by the page; the token transfer after the sweep is mined. */
async function sendFunds(page: Page, w: TestWallet, times: Record<string, number>, t0: number, expected = 2) {
  await expect(page.getByTestId('send-funds')).toBeEnabled();
  await page.getByTestId('send-funds').click();
  await expect.poll(() => w.sent.length, { timeout: 8 * MIN }).toBe(expected);
  times.fundsSent = since(t0);
  await expect(page.getByTestId('funding-token')).toContainText('confirmed', { timeout: 10 * MIN });
  await expect(page.getByTestId('funding-eth')).toContainText('confirmed', { timeout: 2 * MIN });
  times.fundsConfirmed = since(t0);
  await shot(page, '04-funded');
  return w.sent.map((s) => ({ to: s.to, value: s.value.toString(), data: s.data, hash: s.hash }));
}

// ── E.2 + E.4 ───────────────────────────────────────────────────────────────────────

test('E.2 + E.4: the full swap through the UI, with a resume after closing the page mid-bridge-in', async ({
  browser,
  baseURL,
}) => {
  test.skip(PHASE !== 'e2', 'phase e2 only');
  const t0 = Date.now();
  const times: Record<string, number> = {};
  const config = await getJson<{ tokens: Array<{ symbol: string; sepoliaAddress: string; midnightColour: string }> }>(
    `${baseURL}/sponsor/v1/config`,
  );
  const tokenAddr = Object.fromEntries(config.tokens.map((t) => [t.symbol, t.sepoliaAddress]));
  const healthBefore = await health(baseURL!);
  const kernelBefore = await getJson(`${KERNEL}/v1/offers/${OFFER}/status`);
  const balancesBefore = await balances(tokenAddr);
  await evidence('e2-00-before', {
    offerId: OFFER,
    kernelStatus: kernelBefore,
    balancesBefore,
    sponsorHealth: healthBefore,
  });

  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  const key = userKey();
  const page1 = await context.newPage();
  const w1 = await installTestWallet(page1, { privateKey: key, live: { rpcUrl: RPC } });
  let swapId: string;
  if (IMPORT_FILE) {
    // Continue a swap opened earlier (its sweep ETH already at the deposit address): import + resume.
    const resumed = await importAndResume(page1, w1, times, t0);
    swapId = resumed.swapId;
    await evidence('e2-01b-imported-and-resumed', {
      swapId,
      record: resumed.record,
      signatures: typedDataCalls(w1).map((t) => t.primaryType),
      times,
    });
  } else {
    const started = await startSwap(page1, w1, times, t0);
    swapId = String(started.record.swapId);
    await evidence('e2-01-opened', {
      swapId,
      listed: started.listed,
      depositAddress: started.deposit,
      tempAddress: started.temp,
      record: started.record,
      times,
    });
  }

  const funding = await sendFunds(page1, w1, times, t0, IMPORT_FILE ? 1 : 2);
  await evidence('e2-02-funded', {
    swapId,
    funding,
    receipts: await Promise.all(funding.map((f) => sepoliaTx(f.hash))),
    times,
  });

  // Bridge-in: the sponsor sees the funds, starts the deposit on Midnight.
  await waitPhase(page1, ['bridging-in'], 15 * MIN, 'bridge-in');
  times.bridgingIn = since(t0);
  await waitBridgeInStage(page1, /Deposit started on Midnight/, 15 * MIN);
  times.depositStarted = since(t0);
  await shot(page1, '05-bridge-in');
  const beforeClose = await swapRecord(page1, swapId);
  await evidence('e2-03-bridge-in-started', { swapId, record: beforeClose, times });

  // E.4: close the page mid-bridge-in; a new page resumes it by signing once.
  await page1.close({ runBeforeUnload: false });
  times.pageClosed = since(t0);
  const page2 = await context.newPage();
  const w2 = await installTestWallet(page2, { privateKey: key, live: { rpcUrl: RPC } });
  await page2.goto('/#swap');
  await connect(page2);
  const rec = page2.locator(`[data-testid=swap-record][data-swap-id="${swapId}"]`);
  await expect(rec).toBeVisible({ timeout: 2 * MIN });
  const phaseAtResume = await rec.getAttribute('data-phase');
  await shot(page2, '06-your-swaps-after-close');
  times.resumeClicked = since(t0);
  await rec.getByTestId('record-resume').click();
  await expect
    .poll(() => typedDataCalls(w2).map((t) => t.primaryType), { timeout: 5 * MIN })
    .toEqual(['StartSwap', 'SponsorAction']);
  expect(typedDataCalls(w2)[0]).toEqual(typedDataCalls(w1)[0]); // the same "start swap" message
  await expect(page2.getByTestId('swap-page')).not.toHaveAttribute('data-status', 'signing', { timeout: 5 * MIN });
  times.resumed = since(t0);
  await shot(page2, '07-resumed');
  const phaseAfterResume = await phaseOf(page2);
  await evidence('e2-04-resumed', {
    swapId,
    phaseAtResume,
    phaseAfterResume,
    signaturesInNewPage: typedDataCalls(w2).map((t) => t.primaryType),
    sameStartMessage: true,
    sendsFromNewPage: w2.sent.length,
    times,
  });
  expect(w2.sent).toEqual([]); // the funds were sent once, from the first page

  // Minted → take (the batcher) → bridge out → done.
  await waitPhase(page2, ['taking', 'bridging-out', 'done'], 45 * MIN, 'minted');
  times.minted = since(t0);
  await shot(page2, '08-taking');
  await waitPhase(page2, ['bridging-out', 'done'], 20 * MIN, 'take');
  times.taken = since(t0);
  await shot(page2, '09-bridging-out');
  const afterTake = await swapRecord(page2, swapId);
  await evidence('e2-05-taken', { swapId, record: afterTake, times });
  await waitPhase(page2, ['done'], 60 * MIN, 'bridge-out');
  times.done = since(t0);
  await shot(page2, '10-done');
  const summary = await page2.getByTestId('done-summary').innerText();
  const final = (await swapRecord(page2, swapId))!;
  const stored = await storedText(page2);
  expect(stored).not.toMatch(/"seed|swapToken|signature/i);

  const balancesAfter = await balances(tokenAddr);
  const healthAfter = await health(baseURL!);
  const bi = final.bridgeIn as Record<string, string>;
  const bo = final.bridgeOut as Record<string, string>;
  const take = final.take as Record<string, string>;
  const sponsorTxs = {
    startDeposit: await midnightTx(bi.startTx),
    completeDeposit: await midnightTx(bi.completeTx),
    take: await midnightTx(take.tx),
    startWithdraw: await midnightTx(bo.startTx),
    completeWithdraw: await midnightTx(bo.completeTx),
  };
  await evidence('e2-06-done', {
    swapId,
    summary,
    record: final,
    sepolia: {
      funding: await Promise.all(funding.map((f) => sepoliaTx(f.hash))),
      sweep: bi.sweepTx ? await sepoliaTx(bi.sweepTx) : null,
      transferOut: bo.sepoliaTx ? await sepoliaTx(bo.sepoliaTx) : null,
    },
    midnight: sponsorTxs,
    balancesBefore,
    balancesAfter,
    sponsorHealthBefore: healthBefore,
    sponsorHealthAfter: healthAfter,
    kernelStatusAfter: await getJson(`${KERNEL}/v1/offers/${OFFER}/status`),
    times,
  });
  expect(final.phase).toBe('done');
  expect(final.outcome).toBe('swapped');
  await context.close();
});

// ── E.3 ─────────────────────────────────────────────────────────────────────────────

test('E.3: the offer is taken by a competitor during the bridge-in: "Swap is not available", then Bridge back', async ({
  browser,
  baseURL,
}) => {
  test.skip(PHASE !== 'e3', 'phase e3 only');
  const t0 = Date.now();
  const times: Record<string, number> = {};
  const config = await getJson<{ tokens: Array<{ symbol: string; sepoliaAddress: string }> }>(
    `${baseURL}/sponsor/v1/config`,
  );
  const tokenAddr = Object.fromEntries(config.tokens.map((t) => [t.symbol, t.sepoliaAddress]));
  const healthBefore = await health(baseURL!);
  const balancesBefore = await balances(tokenAddr);
  await evidence('e3-00-before', {
    offerId: OFFER,
    kernelStatus: await getJson(`${KERNEL}/v1/offers/${OFFER}/status`),
    balancesBefore,
    sponsorHealth: healthBefore,
  });

  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const w = await installTestWallet(page, { privateKey: userKey(), live: { rpcUrl: RPC } });
  const started = await startSwap(page, w, times, t0);
  const swapId = String(started.record.swapId);
  await evidence('e3-01-opened', {
    swapId,
    listed: started.listed,
    depositAddress: started.deposit,
    tempAddress: started.temp,
    record: started.record,
    times,
  });
  const funding = await sendFunds(page, w, times, t0);
  await evidence('e3-02-funded', {
    swapId,
    funding,
    receipts: await Promise.all(funding.map((f) => sepoliaTx(f.hash))),
    times,
  });
  await waitPhase(page, ['bridging-in'], 15 * MIN, 'bridge-in');
  await waitBridgeInStage(page, /Deposit started on Midnight/, 15 * MIN);
  times.depositStarted = since(t0);
  await shot(page, '05-bridge-in');

  // The operator's competitor takes the offer now (run-live.sh competitor-take, on this marker).
  await writeFile(
    join(STATE_DIR, 'e3-ready.json'),
    `${JSON.stringify({ swapId, offerId: OFFER, at: new Date().toISOString() })}\n`,
  );
  console.log(`[${new Date().toISOString()}] e3: bridge-in started; waiting for the competitor's take of ${OFFER}`);

  await expect(page.getByTestId('not-available')).toBeVisible({ timeout: 50 * MIN });
  times.notAvailable = since(t0);
  await expect(page.getByTestId('not-available')).toContainText('Swap is not available.');
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'unavailable');
  await shot(page, '06-not-available');
  const kernelAtUnavailable = await getJson(`${KERNEL}/v1/offers/${OFFER}/status`);
  await evidence('e3-03-not-available', {
    swapId,
    kernelStatus: kernelAtUnavailable,
    record: await swapRecord(page, swapId),
    times,
  });

  await page.getByTestId('bridge-back').click();
  times.bridgeBackClicked = since(t0);
  await waitPhase(page, ['bridging-back', 'done'], 10 * MIN, 'bridge-back');
  await shot(page, '07-bridging-back');
  await waitPhase(page, ['done'], 60 * MIN, 'bridge-back-done');
  times.done = since(t0);
  await shot(page, '08-done');
  const summary = await page.getByTestId('done-summary').innerText();
  const final = (await swapRecord(page, swapId))!;
  expect(await storedText(page)).not.toMatch(/"seed|swapToken|signature/i);
  const bi = final.bridgeIn as Record<string, string>;
  const bo = final.bridgeOut as Record<string, string>;
  await evidence('e3-04-done', {
    swapId,
    summary,
    record: final,
    sepolia: {
      funding: await Promise.all(funding.map((f) => sepoliaTx(f.hash))),
      sweep: bi.sweepTx ? await sepoliaTx(bi.sweepTx) : null,
      transferBack: bo.sepoliaTx ? await sepoliaTx(bo.sepoliaTx) : null,
    },
    midnight: {
      startDeposit: await midnightTx(bi.startTx),
      completeDeposit: await midnightTx(bi.completeTx),
      startWithdraw: await midnightTx(bo.startTx),
      completeWithdraw: await midnightTx(bo.completeTx),
    },
    balancesBefore,
    balancesAfter: await balances(tokenAddr),
    sponsorHealthBefore: healthBefore,
    sponsorHealthAfter: await health(baseURL!),
    times,
  });
  expect(final.outcome).toBe('bridged-back');
  expect(existsSync(join(STATE_DIR, 'e3-ready.json'))).toBe(true);
  await context.close();
});

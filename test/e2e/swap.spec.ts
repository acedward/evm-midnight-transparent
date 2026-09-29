// Plan L-WEB: the swap page against the mock ports (exchange, sponsor, wallet module in the page) and
// the test wallet (its key in this Node process, fake Sepolia balances).
//
//   - the happy path: three signatures (the same "start swap" twice, then the sponsor's), the two
//     Sepolia transactions (the sized sweep ETH, then exactly the offer's amount, both to the deposit
//     address), bridge-in stages, the take, bridge-out, done, and every hash linked;
//   - "Swap is not available" at take time, then Bridge back;
//   - a wallet that signs differently each time: the warning, Cancel sends nothing, Continue marks the
//     swap as not recoverable;
//   - resume: the tab closes mid-bridge-in; a new tab signs the start message once and finishes it;
//   - a refunded withdrawal is retried on its own (Q9 A).

import { expect, test } from '@playwright/test';
import { getAddress } from 'ethers';

import {
  USDC,
  bridgeInStagesAtLeast,
  connect,
  setMockStep,
  fundSwap,
  richWallet,
  serveApp,
  stage,
  startAskSwap,
  typedDataCalls,
  watchExternal,
  withWallet,
} from './fixtures.js';
import { installTestWallet, reopenTestWallet } from './test-wallet.js';

const SWEEP_WEI = 65_000n * 2_500_000_000n;
const transfer = (to: string, amount: bigint) =>
  `0xa9059cbb${to.toLowerCase().replace(/^0x/, '').padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;

test('the whole swap (happy path), with every stage and hash', async ({ page }) => {
  const external = watchExternal(page);
  const wallet = await withWallet(page);
  await serveApp(page, { stepMs: 400 });
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);

  // Stage 1: three signature prompts; the first two are the same "start swap" message.
  await expect(page.getByTestId('send-funds')).toBeVisible();
  const signed = typedDataCalls(wallet);
  expect(signed.map((t) => t.primaryType)).toEqual(['StartSwap', 'StartSwap', 'SponsorAction']);
  expect(signed[0]).toEqual(signed[1]);
  expect(signed[2]!.message).toMatchObject({ action: 'open-swap', network: 'stagenet', owner: wallet.address });
  await expect(page.getByTestId('recoverable')).toBeVisible();
  await expect(stage(page, 'start')).toHaveAttribute('data-state', 'done');
  await expect(stage(page, 'fund')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('temp-address')).toHaveAttribute('data-value', /^mn_shield-addr_stagenet1/);

  // Stage 2: the two Sepolia transactions, sweep ETH first, then exactly 1.04 USDC.
  const deposit = getAddress((await page.getByTestId('deposit-address').getAttribute('data-value'))!);
  expect(wallet.sent).toEqual([]);
  await fundSwap(page);
  await expect.poll(() => wallet.sent.length).toBe(2);
  expect(wallet.sent[0]).toMatchObject({ to: deposit, value: SWEEP_WEI, data: '' });
  expect(wallet.sent[1]).toMatchObject({ to: USDC, value: 0n, data: transfer(deposit, 1_040_000n) });
  await expect(page.getByTestId('funding-eth')).toContainText('0.0001625 ETH');
  await expect(page.getByTestId('funding-token')).toContainText('confirmed');

  // Stage 3: bridge-in, its estimate and its stages (the mock clock held while it is checked).
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'bridging-in');
  await setMockStep(page, 600_000);
  await expect(stage(page, 'bridge-in')).toHaveAttribute('data-state', 'current');
  await expect(stage(page, 'bridge-in')).toContainText('About 18 minutes');
  await setMockStep(page, 100);
  await expect(page.getByTestId('bridge-in-stages').locator('li')).toHaveCount(7);

  // Stages 4–6: take, bridge out, done.
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
  for (const k of ['start', 'fund', 'bridge-in', 'take', 'bridge-out', 'done'])
    await expect(stage(page, k)).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('done-summary')).toHaveText(
    'You paid 1.04 USDC and received 100.00 stkA. The temporary wallet is empty.',
  );
  await expect(page.getByTestId('arrived')).toContainText('100.00 stkA arrived on Sepolia');

  // Every hash, linked: Sepolia to Etherscan, bridge requests to the sig-net explorer; Midnight ones
  // are copyable (no stagenet Midnight explorer is configured: Q11).
  const lines = page.getByTestId('all-hashes').getByTestId('tx-line');
  await expect(lines).toHaveCount(11);
  for (const l of await lines.all()) {
    const kind = await l.getAttribute('data-kind');
    const links = l.locator('a');
    const href = (await links.count()) > 0 ? await links.first().getAttribute('href') : null;
    if (kind === 'sepolia') expect(href).toMatch(/^https:\/\/sepolia\.etherscan\.io\/tx\/0x[0-9a-fA-F]{64}$/);
    if (kind === 'request')
      expect(href).toMatch(
        /^https:\/\/sig-net\.github\.io\/explorer\/midnight\/explorer\?networkId=stagenet&requestId=0x[0-9a-f]{64}$/,
      );
    if (kind === 'midnight') expect(href).toBeNull();
  }

  // Your swaps and Local data list the record, which holds no signature.
  await page.goto('/#swap');
  await expect(page.locator('[data-testid=swap-record][data-phase=done]')).toHaveCount(1);
  await page.getByTestId('tab-local').click();
  await expect(page.locator('[data-testid=record-row][data-kind=swap]')).toHaveCount(1);
  const stored = await page.evaluate(() =>
    Object.entries({ ...localStorage })
      .filter(([k]) => k.startsWith('evm-midnight-transparent/'))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
  );
  expect(stored).toContain('/swap/');
  expect(stored).not.toMatch(/"seed|swapToken|signature/i);
  expect(external).toEqual([]);
});

test('"Swap is not available" at take time, then Bridge back', async ({ page }) => {
  await withWallet(page);
  // A Midnight explorer configured: Midnight hashes are linked too.
  await serveApp(
    page,
    { scenario: { offerGoneAtTake: true } },
    { midnight: { explorerUrl: 'https://explorer.test/midnight' } },
  );
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await fundSwap(page);
  await expect(page.getByTestId('not-available')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('not-available')).toContainText('Swap is not available.');
  await expect(page.getByTestId('not-available')).toContainText('1.04 wUSDC is safe');
  await expect(stage(page, 'take')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'unavailable');
  await page.getByTestId('bridge-back').click();
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
  await expect(page.getByTestId('done-summary')).toContainText(
    'The swap did not happen: 1.04 USDC came back to your address.',
  );
  await expect(stage(page, 'bridge-out')).toContainText('Bridge back');
  await expect(stage(page, 'take')).toHaveAttribute('data-state', 'failed');
  const midnight = page.locator('[data-testid=all-hashes] [data-testid=tx-line][data-kind=midnight] a');
  await expect(midnight.first()).toHaveAttribute('href', /^https:\/\/explorer\.test\/midnight\/tx\/[0-9a-f]+$/);
  await expect(page.locator('[data-testid=all-hashes] [data-name=take]')).toHaveCount(0);
});

test('a wallet that signs differently: the warning; Cancel sends nothing; Continue marks it not recoverable', async ({
  page,
}) => {
  const wallet = await withWallet(page, { nonDeterministic: true });
  await serveApp(page);
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await expect(page.getByTestId('nondet-dialog')).toBeVisible();
  await expect(page.getByTestId('nondet-dialog')).toContainText('cannot be recovered after this tab closes');
  const [a, b] = typedDataCalls(wallet);
  expect(a).toEqual(b); // the same message, signed twice
  await page.getByTestId('nondet-cancel').click();
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-status', 'stopped');
  await expect(page.getByTestId('swap-page')).toContainText('You cancelled the swap. Nothing was sent.');
  const posts = await page.evaluate(() =>
    (window as unknown as { __emtMock: { requests(): Array<{ method: string }> } }).__emtMock
      .requests()
      .filter((r) => r.method === 'POST'),
  );
  expect(posts).toEqual([]);
  expect(typedDataCalls(wallet)).toHaveLength(2);

  await page.goto('/#swap');
  await startAskSwap(page);
  await page.getByTestId('nondet-continue').click();
  await expect(page.getByTestId('send-funds')).toBeVisible();
  await expect(page.getByTestId('nondet-warning')).toContainText('cannot be recovered if this tab closes');
  await expect(page.getByTestId('not-recoverable')).toBeVisible();
});

test('resume: the tab closes mid-bridge-in; a new tab signs once and finishes the swap', async ({ context }) => {
  const sepolia = richWallet();
  const first = await context.newPage();
  const w1 = await installTestWallet(first, { sepolia });
  await serveApp(first, { stepMs: 1_000 });
  await first.goto('/#swap');
  await connect(first);
  await startAskSwap(first);
  await fundSwap(first);
  await expect(first.getByTestId('swap-page')).toHaveAttribute('data-phase', 'bridging-in');
  await bridgeInStagesAtLeast(first, 2);
  await first.close({ runBeforeUnload: false });

  // A new tab, the same wallet: the swap is in Your swaps, not running.
  const second = await context.newPage();
  const w2 = await reopenTestWallet(second, w1, sepolia);
  await serveApp(second, { stepMs: 120 });
  await second.goto('/#swap');
  await connect(second);
  const rec = second.locator('[data-testid=swap-record][data-phase=bridging-in]');
  await expect(rec).toHaveCount(1);
  await rec.getByTestId('record-resume').click();
  await expect(second.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
  // One "start swap" signature (the coin key must match the record's) and the sponsor's re-open.
  expect(typedDataCalls(w2).map((t) => t.primaryType)).toEqual(['StartSwap', 'SponsorAction']);
  expect(typedDataCalls(w2)[0]).toEqual(typedDataCalls(w1)[0]);
  // The funds were sent once, from the first tab.
  expect(w2.sent).toEqual([]);
  expect(w1.sent).toHaveLength(2);
  await expect(second.getByTestId('done-summary')).toContainText('You paid 1.04 USDC and received 100.00 stkA');
});

test('a refunded withdrawal is rebuilt and resubmitted on its own (Q9 A)', async ({ page }) => {
  await withWallet(page);
  await serveApp(page, { scenario: { refundFirstWithdrawal: true } });
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await fundSwap(page);
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 40_000 });
  await expect(page.getByTestId('refunds')).toContainText('1 earlier withdrawal was refunded');
  await expect(page.locator('[data-testid=all-hashes] [data-name^=refunded-0]')).toHaveCount(3);
});

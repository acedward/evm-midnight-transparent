// Plan 00048 P4.2-fix4, lane FW4, in the browser against the mock ports and the test wallet (the owner's
// live swap, evidence/00048-evm-midnight-transparent/owner-test/owner-swap-1.md):
//
//   - Done on arrival: the swap shows Done as soon as the bridge's transfer to the user is mined and
//     its receipt carries the expected ERC20 Transfer (read through the wallet, never the sponsor's
//     word), with a quiet note while the bridge closes the request; Your swaps shows the same; the
//     page keeps following the bridge until it says done;
//   - never Done for a failed (reverted) transfer, another token, another amount, or the first part
//     of a partial Bridge back with the rest still to come;
//   - every stage id in the two stage lists has a human title (the owner saw "evm-pending" raw);
//   - the Done-on-arrival page and Your swaps at 1280 and 375 px, with the rendered contrast.

import { expect, test, type Page } from '@playwright/test';
import { getAddress } from 'ethers';

import {
  USDC,
  VISUAL_OUT,
  assertContrast,
  assertLayout,
  connect,
  fundSwap,
  richWallet,
  serveApp,
  setMockStep,
  shot,
  stage,
  startAskSwap,
  withWallet,
} from './fixtures.js';
import type { FakeSepolia, TestWallet } from './test-wallet.js';

const mock = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ({ fn, args }) =>
      (window as unknown as { __emtMock: Record<string, (...a: unknown[]) => unknown> }).__emtMock[fn]!(...args),
    { fn, args },
  ) as Promise<T>;

type View = { state: string; withdraw?: { stage?: string; sepoliaTx?: string; refunds?: number } };
const views = (page: Page) => mock<View[]>(page, 'views');
const swapPage = (page: Page) => page.getByTestId('swap-page');

/** Every sub-stage of a list shows a title, never its raw id. */
async function expectTitled(page: Page, testId: string): Promise<void> {
  const items = page.getByTestId(testId).locator('li');
  const n = await items.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const li = items.nth(i);
    const id = (await li.getAttribute('data-stage'))!;
    const title = (await li.locator('span').first().textContent())!.trim();
    expect(title, `the stage ${id} has a title`).not.toBe(id);
    expect(title).toMatch(/^[A-Z]/);
  }
}

test('Done on arrival: Done once the verified transfer lands, a quiet note while the bridge closes; Your swaps too', async ({
  page,
}) => {
  await withWallet(page);
  await serveApp(page, { stepMs: 150, scenario: { holdAfterTransfer: true } });
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await fundSwap(page);

  // The bridge's transfer is mined; the bridge still has ~17 minutes of closing (held here).
  await expect(swapPage(page)).toHaveAttribute('data-done', 'closing', { timeout: 40_000 });
  await expect(swapPage(page)).toHaveAttribute('data-status', 'done');
  await expect(swapPage(page)).toHaveAttribute('data-phase', 'bridging-out');
  expect((await views(page))[0]!.state).toBe('withdrawing');
  await expect(swapPage(page).locator('.page-head .lede')).toHaveText('Done.');
  for (const k of ['start', 'fund', 'bridge-in', 'take', 'bridge-out', 'done'])
    await expect(stage(page, k)).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('done-summary')).toHaveText(
    'You paid 1.04 USDC and received 100.00 stkA. The temporary wallet is empty.',
  );
  await expect(page.getByTestId('closing-note')).toHaveText(
    'The bridge closes the request on Midnight in the background (about 17 minutes); there is nothing for you to do.',
  );
  await expect(page.getByTestId('arrived')).toHaveAttribute('data-full', 'yes');
  await expect(page.getByTestId('arrived')).toContainText('100.00 stkA arrived on Sepolia.');
  await expect(page.getByTestId('resume-here')).toHaveCount(0);

  // Both stage lists, every stage titled: evm-pending is "Waiting for the Sepolia transaction".
  for (const list of ['bridge-in-stages', 'bridge-out-stages']) {
    await expect(page.getByTestId(list).locator('li[data-stage=evm-pending]')).toContainText(
      'Waiting for the Sepolia transaction',
    );
    await expectTitled(page, list);
  }
  await page.getByTestId('bridge-in-stages').screenshot({ path: `${VISUAL_OUT}/fix4-bridge-in-stages-titled.png` });
  await page.getByTestId('bridge-out-stages').screenshot({ path: `${VISUAL_OUT}/fix4-bridge-out-stages-titled.png` });
  await shot(page, 'fix4-swap-done-on-arrival');

  // Your swaps: Done, the same quiet note, Open (nothing to resume); the swap keeps running here.
  await page.goto('/#swap');
  const row = page.locator('[data-testid=swap-record]');
  await expect(row).toHaveAttribute('data-done', 'closing');
  await expect(row).toContainText('Done');
  await expect(row).toContainText('the bridge closes the request in the background');
  await expect(row.getByTestId('record-open')).toBeVisible();
  await expect(row.getByTestId('record-resume')).toHaveCount(0);
  await shot(page, 'fix4-your-swaps-done-on-arrival');

  // The bridge closes the request: the sponsor's done; the note goes.
  await mock(page, 'setScenario', { holdAfterTransfer: false });
  await row.getByTestId('record-open').click();
  await expect(swapPage(page)).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
  await expect(swapPage(page)).toHaveAttribute('data-done', 'closed');
  await expect(page.getByTestId('closing-note')).toHaveCount(0);
  await expect(page.getByTestId('done-summary')).toContainText('You paid 1.04 USDC and received 100.00 stkA.');
});

test('not Done for a failed (reverted) transfer: the page says so; the refund is retried; Done when the retry lands', async ({
  page,
}) => {
  await withWallet(page);
  await serveApp(page, { stepMs: 150, scenario: { transferReceipt: 'reverted', holdAfterTransfer: true } });
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await fundSwap(page);
  // The page read the reverted receipt: no Done, the page says why.
  await expect(page.getByTestId('swap-notice')).toContainText('failed on Sepolia', { timeout: 40_000 });
  await expect(swapPage(page)).toHaveAttribute('data-done', 'no');
  expect(await swapPage(page).getAttribute('data-status')).not.toBe('done');
  await expect(page.getByTestId('arrived')).toHaveCount(0);
  // The bridge refunds, the page builds the withdrawal again; its transfer verifies: Done.
  await expect(swapPage(page)).toHaveAttribute('data-done', 'closing', { timeout: 40_000 });
  const [v] = await views(page);
  expect(v!.withdraw?.refunds).toBe(1);
  await expect(page.getByTestId('refunds')).toContainText('1 earlier withdrawal was refunded');
});

for (const [kind, text] of [
  ['wrong-token', 'does not carry the transfer of stkA'],
  ['older', 'was mined before you funded this swap'],
  // P4.2-fix5 U4 (F-B53): another withdrawal's payout of the same token and amount to the same user.
  ['foreign', "is not this swap's own withdrawal"],
] as const) {
  test(`not Done for a transfer the page does not count (${kind})`, async ({ page }) => {
    await withWallet(page);
    await serveApp(page, { stepMs: 150, scenario: { transferReceipt: kind, holdAfterTransfer: true } });
    await page.goto('/#swap');
    await connect(page);
    await startAskSwap(page);
    await fundSwap(page);
    await expect(page.getByTestId('swap-notice')).toContainText(text, { timeout: 40_000 });
    await page.waitForTimeout(1_500);
    await expect(swapPage(page)).toHaveAttribute('data-done', 'no');
    await expect(swapPage(page)).toHaveAttribute('data-status', 'working');
    await expect(page.getByTestId('arrived')).toHaveCount(0);
    await expect(page.getByTestId('closing-note')).toHaveCount(0);
  });
}

test('not Done for another amount: what arrived is shown as part of the whole', async ({ page }) => {
  await withWallet(page);
  await serveApp(page, { stepMs: 150, scenario: { transferReceipt: 'wrong-amount', holdAfterTransfer: true } });
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await fundSwap(page);
  await expect(page.getByTestId('arrived')).toContainText('99.999999 of 100.00 stkA arrived on Sepolia so far.', {
    timeout: 40_000,
  });
  await expect(page.getByTestId('arrived')).toHaveAttribute('data-full', 'no');
  await page.waitForTimeout(1_500);
  await expect(swapPage(page)).toHaveAttribute('data-done', 'no');
  await expect(stage(page, 'done')).toHaveAttribute('data-state', 'pending');
});

const storedSwaps = (page: Page) =>
  page.evaluate(() =>
    Object.entries({ ...localStorage })
      .filter(([k]) => k.startsWith('evm-midnight-transparent/') && k.includes('/swap/'))
      .map(([, v]) => JSON.parse(v) as { data: { funding: { token?: { status?: string } } } }),
  );

/** As test/e2e/fix3-pass.spec.ts: fund, then another party's request sweeps `units` (with the sweep
 *  ETH) and the sponsor completes it: a partial deposit. */
async function partialDeposit(page: Page, wallet: TestWallet, sepolia: FakeSepolia, units: bigint): Promise<void> {
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await expect(page.getByTestId('send-funds')).toBeEnabled();
  const deposit = getAddress((await page.getByTestId('deposit-address').getAttribute('data-value'))!);
  await setMockStep(page, 600_000);
  await fundSwap(page);
  await expect.poll(() => wallet.sent.length).toBe(2);
  await expect.poll(async () => (await storedSwaps(page))[0]?.data.funding.token?.status).toBe('confirmed');
  const key = `${USDC.toLowerCase()}:${deposit.toLowerCase()}`;
  sepolia.others!.erc20![key] = sepolia.others!.erc20![key]! - units;
  sepolia.others!.eth![deposit.toLowerCase()] = 0n;
  await mock(page, 'partialSweep', units.toString());
  await setMockStep(page, 120);
}

test('a partial Bridge back is not Done while the rest is still to come; Done when everything came back', async ({
  page,
}) => {
  const sepolia = richWallet();
  const wallet = await withWallet(page, { sepolia });
  await serveApp(page, { scenario: { holdAfterTransfer: true } });
  await partialDeposit(page, wallet, sepolia, 40_000n);
  await expect(page.getByTestId('partial-bridge-back')).toBeEnabled({ timeout: 15_000 });
  await page.getByTestId('partial-bridge-back').click();

  // The first part (0.04 USDC) arrived, verified: shown as a part, never Done.
  await expect(page.getByTestId('arrived')).toContainText('0.04 of 1.04 USDC came back on Sepolia so far.', {
    timeout: 30_000,
  });
  await page.waitForTimeout(1_500);
  await expect(swapPage(page)).toHaveAttribute('data-done', 'no');
  expect(await swapPage(page).getAttribute('data-status')).not.toBe('done');
  await expect(stage(page, 'done')).toHaveAttribute('data-state', 'pending');
  await shot(page, 'fix4-partial-back-first-part');

  // The bridge closes that part; the rest waits at the deposit address (the sweep ETH to top up).
  await mock(page, 'setScenario', { holdAfterTransfer: false });
  await expect(page.getByTestId('partial-top-up')).toBeEnabled({ timeout: 30_000 });
  await expect(swapPage(page)).toHaveAttribute('data-done', 'no');
  await mock(page, 'setScenario', { holdAfterTransfer: true });
  await page.getByTestId('partial-top-up').click();

  // The rest is bridged in and back: everything came back: Done on arrival.
  await expect(swapPage(page)).toHaveAttribute('data-done', 'closing', { timeout: 40_000 });
  await expect(page.getByTestId('arrived')).toContainText('1.04 USDC came back on Sepolia.');
  await expect(page.getByTestId('done-summary')).toContainText(
    'The swap did not happen: 1.04 USDC came back to your address, in parts.',
  );
  await expect(swapPage(page).locator('.page-head .lede')).toHaveText('Bridged back.');
  await mock(page, 'setScenario', { holdAfterTransfer: false });
  await expect(swapPage(page)).toHaveAttribute('data-phase', 'done', { timeout: 30_000 });
});

// The Done-on-arrival page and Your swaps at 1280 px and on a 375 px phone: no horizontal scroll,
// 44 px buttons on the phone, every text at WCAG AA contrast (as layout.spec.ts checks the others).
for (const vp of [
  { name: 'desktop1280', width: 1280, height: 900, touch: false },
  { name: 'phone375', width: 375, height: 812, touch: true },
] as const) {
  test.describe(`P4.2-fix4 layout at ${vp.width} px`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.touch,
      isMobile: vp.touch,
      deviceScaleFactor: vp.touch ? 2 : 1,
    });

    test('Done on arrival, the titled stage lists, and Your swaps', async ({ page }) => {
      await withWallet(page);
      await serveApp(page, { stepMs: 150, scenario: { holdAfterTransfer: true } });
      await page.goto('/#swap');
      await connect(page);
      await startAskSwap(page);
      await fundSwap(page);
      await expect(swapPage(page)).toHaveAttribute('data-done', 'closing', { timeout: 40_000 });
      await expect(page.getByTestId('closing-note')).toBeVisible();
      await assertLayout(page, vp.touch);
      await assertContrast(page);
      await shot(page, `${vp.name}-swap-done-on-arrival`);
      await page
        .getByTestId('bridge-out-stages')
        .screenshot({ path: `${VISUAL_OUT}/${vp.name}-bridge-out-stages.png` });
      await page.goto('/#swap');
      await expect(page.locator('[data-testid=swap-record][data-done=closing]')).toHaveCount(1);
      await assertLayout(page, vp.touch);
      await assertContrast(page);
      await shot(page, `${vp.name}-your-swaps-done-on-arrival`);
    });
  });
}

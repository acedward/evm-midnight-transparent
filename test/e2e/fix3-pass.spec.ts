// Plan 00048 P4.2-fix3, lane FW3: the security audit's round-3 row S2 (F-A32, F-B33), page side, in the
// browser against the mock ports and the test wallet. Another party's 1-unit `startDeposit` for the
// swap's recipient wins the sweep race (its sweep spends the sweep ETH at the deposit address), and
// the sponsor completes it: part of the pay amount reaches the temporary wallet, the rest stays at the
// deposit address. The page must show both amounts, never wait for it silently, never send the token
// again, and let the user either wait for the rest or bridge back what arrived.

import { expect, test, type Page } from '@playwright/test';
import { getAddress } from 'ethers';

import {
  USDC,
  assertContrast,
  assertLayout,
  connect,
  fundSwap,
  richWallet,
  serveApp,
  setMockStep,
  shot,
  startAskSwap,
  withWallet,
} from './fixtures.js';
import type { FakeSepolia, TestWallet } from './test-wallet.js';

const SWEEP_WEI = 65_000n * 2_500_000_000n;

const mock = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ({ fn, args }) =>
      (window as unknown as { __emtMock: Record<string, (...a: unknown[]) => unknown> }).__emtMock[fn]!(...args),
    { fn, args },
  ) as Promise<T>;

const storedSwaps = (page: Page) =>
  page.evaluate(() =>
    Object.entries({ ...localStorage })
      .filter(([k]) => k.startsWith('evm-midnight-transparent/') && k.includes('/swap/'))
      .map(([, v]) => JSON.parse(v) as { data: { funding: { token?: { status?: string } } } }),
  );

/** Start the 1.04 USDC → 100 stkA swap, fund it, and turn its deposit partial: `units` swept by
 *  another party's request (with the sweep ETH), completed by the sponsor. Returns the deposit address. */
async function partialDeposit(page: Page, wallet: TestWallet, sepolia: FakeSepolia, units: bigint): Promise<string> {
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await expect(page.getByTestId('send-funds')).toBeEnabled();
  const deposit = getAddress((await page.getByTestId('deposit-address').getAttribute('data-value'))!);
  // Hold the sponsor where it is: it has not seen the funds when the other request sweeps them.
  await setMockStep(page, 600_000);
  await fundSwap(page);
  await expect.poll(() => wallet.sent.length).toBe(2);
  await expect.poll(async () => (await storedSwaps(page))[0]?.data.funding.token?.status).toBe('confirmed');
  const key = `${USDC.toLowerCase()}:${deposit.toLowerCase()}`;
  sepolia.others!.erc20![key] = sepolia.others!.erc20![key]! - units;
  sepolia.others!.eth![deposit.toLowerCase()] = 0n;
  await mock(page, 'partialSweep', units.toString());
  await setMockStep(page, 120);
  return deposit;
}

test('S2: a partial deposit shows what arrived; "Wait for the rest" tops up only the sweep ETH and the swap completes', async ({
  page,
}) => {
  const sepolia = richWallet();
  const wallet = await withWallet(page, { sepolia });
  await serveApp(page);
  const deposit = await partialDeposit(page, wallet, sepolia, 1n);

  // Not a silent wait: the choice, both amounts, and no Send funds for the token.
  const panel = page.getByTestId('partial-deposit');
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-status', 'partial');
  await expect(page.getByTestId('partial-arrived')).toContainText('0.000001 USDC');
  await expect(page.getByTestId('partial-missing')).toContainText('1.039999 USDC');
  await expect(page.getByTestId('send-funds')).toHaveCount(0);
  await expect(page.getByTestId('partial-bridge-back')).toBeEnabled();
  // Nothing leaves the wallet before the user chooses.
  await page.waitForTimeout(1_500);
  expect(wallet.sent).toHaveLength(2);

  await page.getByTestId('partial-wait').click();
  await expect(panel).toHaveAttribute('data-wait', 'yes');
  await expect(page.getByTestId('partial-waiting')).toContainText('1.039999 USDC');
  // The other request's sweep spent the sweep ETH: the page asks for that ETH only.
  await expect(page.getByTestId('partial-top-up')).toBeEnabled();
  await expect(page.getByTestId('swap-notice')).toContainText('your USDC is not sent again');
  // Bridge back stays on offer while waiting.
  await expect(page.getByTestId('partial-bridge-back')).toBeEnabled();
  await page.getByTestId('partial-top-up').click();
  await expect.poll(() => wallet.sent.length).toBe(3);
  expect(wallet.sent[2]).toMatchObject({ to: deposit, value: SWEEP_WEI, data: '' });

  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 40_000 });
  await expect(page.getByTestId('done-summary')).toContainText('You paid 1.04 USDC and received 100.00 stkA');
  // The token went once, the sweep ETH twice (the top-up): nothing else, nothing automatic.
  expect(wallet.sent.map((t) => (t.data ? 'token' : t.value))).toEqual([SWEEP_WEI, 'token', SWEEP_WEI]);
});

test('S2: after the tab closed, Resume shows the partial deposit; "Bridge back" returns what arrived, then the rest', async ({
  page,
}) => {
  const sepolia = richWallet();
  const wallet = await withWallet(page, { sepolia });
  await serveApp(page);
  const deposit = await partialDeposit(page, wallet, sepolia, 40_000n);
  await expect(page.getByTestId('partial-deposit')).toBeVisible({ timeout: 15_000 });

  // The tab closes; Your swaps says what happened, and Resume brings the choice back.
  await page.reload();
  await connect(page);
  await page.goto('/#swap');
  const row = page.locator('[data-testid=swap-record]');
  await expect(row).toContainText('Part of the deposit arrived');
  await row.getByTestId('record-resume').click();
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-status', 'partial', { timeout: 15_000 });
  await expect(page.getByTestId('partial-arrived')).toContainText('0.04 USDC');
  await expect(page.getByTestId('partial-missing')).toContainText('1.00 USDC');
  await expect(page.getByTestId('partial-at-address')).toContainText('1.00 USDC');

  // Bridge back: what arrived goes back now; the rest is deposited (the sweep ETH topped up by the
  // user: the other request's sweep spent it) and bridged back too (FS3 item 5).
  await page.getByTestId('partial-bridge-back').click();
  const back = page.getByTestId('partial-back');
  await expect(back).toContainText('is bridged into the temporary wallet first, then back to you', { timeout: 20_000 });
  await expect(page.getByTestId('partial-top-up')).toBeEnabled();
  expect(wallet.sent).toHaveLength(2);
  await page.getByTestId('partial-top-up').click();
  await expect.poll(() => wallet.sent.length).toBe(3);
  expect(wallet.sent[2]).toMatchObject({ to: deposit, value: SWEEP_WEI, data: '' });

  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 40_000 });
  await expect(page.getByTestId('done-summary')).toContainText(
    'The swap did not happen: 1.04 USDC came back to your address, in parts.',
  );
  // The token went once; the only other transfers were the sweep ETH (and its top-up).
  expect(wallet.sent.map((t) => (t.data ? 'token' : t.value))).toEqual([SWEEP_WEI, 'token', SWEEP_WEI]);
  const views = await mock<Array<{ outcome?: string }>>(page, 'views');
  expect(views[0]?.outcome).toBe('bridged-back');
});

// The partial-deposit panel at 1280 px and on a 375 px phone: no horizontal scroll, 44 px buttons on
// the phone, every text at WCAG AA contrast (as layout.spec.ts checks the other pages).
for (const vp of [
  { name: 'desktop1280', width: 1280, height: 900, touch: false },
  { name: 'phone375', width: 375, height: 812, touch: true },
] as const) {
  test.describe(`S2 layout at ${vp.width} px`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.touch,
      isMobile: vp.touch,
      deviceScaleFactor: vp.touch ? 2 : 1,
    });

    test('the partial-deposit choice, and the wait for the rest', async ({ page }) => {
      const sepolia = richWallet();
      const wallet = await withWallet(page, { sepolia });
      await serveApp(page);
      await partialDeposit(page, wallet, sepolia, 1n);
      await expect(page.getByTestId('partial-deposit')).toBeVisible({ timeout: 15_000 });
      await assertLayout(page, vp.touch);
      await assertContrast(page);
      await shot(page, `${vp.name}-swap-partial`);
      await page.getByTestId('partial-wait').click();
      await expect(page.getByTestId('partial-top-up')).toBeEnabled();
      await assertLayout(page, vp.touch);
      await assertContrast(page);
      await shot(page, `${vp.name}-swap-partial-wait`);
    });
  });
}

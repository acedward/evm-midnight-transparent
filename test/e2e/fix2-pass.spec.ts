// Plan 00048 P4.2-fix2, lane FW2: the security audit's round-2 page-side fixes, in the browser against
// the mock ports (the mock wallet books coins as the real one does) and the test wallet.
//
//   R3 (F-B24)  a withdrawal the sponsor accepted and whose start then failed: the page releases its
//               booked coin and the retry builds at once;
//   R3 (F-B25)  a failed swap whose stored record does not say whether it is recoverable (written
//               before P4.2-fix) is offered for Resume, and the sponsor's answer decides;
//   R7 (F-B23)  a swap resumed after the sponsor raised its sweep gas offers Send funds again, and
//               only the missing ETH is sent.

import { expect, test, type Page } from '@playwright/test';
import { getAddress } from 'ethers';

import { connect, fundSwap, richWallet, serveApp, setMockStep, startAskSwap, withWallet } from './fixtures.js';

const SWEEP_WEI = 65_000n * 2_500_000_000n;

const mock = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ({ fn, args }) =>
      (window as unknown as { __emtMock: Record<string, (...a: unknown[]) => unknown> }).__emtMock[fn]!(...args),
    { fn, args },
  ) as Promise<T>;

/** The swap records this page stored (key and parsed value). */
const storedSwaps = (page: Page) =>
  page.evaluate(() =>
    Object.entries({ ...localStorage })
      .filter(([k]) => k.startsWith('evm-midnight-transparent/') && k.includes('/swap/'))
      .map(([k, v]) => ({ key: k, value: JSON.parse(v) as { data: Record<string, unknown> } })),
  );

test('R3 (F-B24): a withdrawal whose start failed after it was accepted releases its booked coin', async ({ page }) => {
  await withWallet(page);
  await serveApp(page, { scenario: { failFirstStart: true } });
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await fundSwap(page);
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 40_000 });
  // The take, the withdrawal whose start failed (released by the page), and its retry.
  expect(await mock<{ drafts: number; released: number }>(page, 'walletStats')).toEqual({ drafts: 3, released: 1 });
  await expect(page.getByTestId('done-summary')).toContainText('You paid 1.04 USDC and received 100.00 stkA');
});

test('R3 (F-B25): a failed swap whose record does not say it is recoverable can be resumed; the sponsor decides', async ({
  page,
}) => {
  await withWallet(page);
  await serveApp(page, { stepMs: 200 });
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await expect(page.getByTestId('send-funds')).toBeVisible();
  // The funds did not arrive in time; the sponsor (after its migration) can revive it.
  await mock(page, 'failAwaitingFunds', true);
  await expect(page.getByTestId('swap-error')).toBeVisible({ timeout: 15_000 });
  // The stored record as a page before P4.2-fix wrote it: no `recoverable`.
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith('evm-midnight-transparent/') || !k.includes('/swap/')) continue;
      const v = JSON.parse(localStorage.getItem(k)!);
      delete v.data.recoverable;
      localStorage.setItem(k, JSON.stringify(v));
    }
  });
  await page.reload();
  await connect(page);
  await page.goto('/#swap');
  const row = page.locator('[data-testid=swap-record][data-phase=failed]');
  await expect(row).toContainText('Failed: resume to ask the sponsor');
  await row.getByTestId('record-resume').click();
  await expect(page.getByTestId('send-funds')).toBeVisible({ timeout: 15_000 });
  await fundSwap(page);
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 40_000 });
});

test('R7 (F-B23): resumed after the sponsor raised the sweep gas, Send funds tops up only the missing ETH', async ({
  page,
}) => {
  const sepolia = richWallet();
  const wallet = await withWallet(page, { sepolia });
  await serveApp(page);
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await expect(page.getByTestId('send-funds')).toBeEnabled();
  const deposit = getAddress((await page.getByTestId('deposit-address').getAttribute('data-value'))!);
  // Hold the sponsor where it is (it has not seen the funds when the tab closes).
  await setMockStep(page, 600_000);
  await fundSwap(page);
  await expect.poll(() => wallet.sent.length).toBe(2);
  await expect
    .poll(
      async () => ((await storedSwaps(page))[0]?.value.data.funding as { token?: { status?: string } }).token?.status,
    )
    .toBe('confirmed');
  // The base fee rose: the sponsor doubles the sweep gas. Then the tab is closed and opened again.
  await mock(page, 'raiseSweepGas');
  await page.reload();
  await connect(page);
  await expect(page.getByTestId('resume-here')).toBeVisible();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('send-funds')).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByTestId('swap-notice')).toContainText('top it up');
  await expect(page.getByTestId('funding-eth')).toContainText('0.000325 ETH');
  await fundSwap(page);
  await expect.poll(() => wallet.sent.length).toBe(3);
  // Only the missing ETH; the token is not sent again.
  expect(wallet.sent[2]).toMatchObject({ to: deposit, value: SWEEP_WEI, data: '' });
  expect(sepolia.others?.eth?.[deposit.toLowerCase()]).toBe(2n * SWEEP_WEI);
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 40_000 });
});

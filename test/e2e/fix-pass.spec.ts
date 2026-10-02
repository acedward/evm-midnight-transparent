// Plan 00048 P4.2-fix, lane FW: the security audit's page-side fixes, in the browser against the mock
// ports (which follow the real sponsor's wire, audit C1) and the test wallet.
//
//   C1   a withdrawal whose start fails after the sponsor accepted it is rebuilt and resubmitted;
//   C5   a failed swap the sponsor marks recoverable is resumed from the page and finishes;
//   C8   an edited swap record cannot change what "Send funds" sends;
//   C9   the wallet switching networks mid-funding pauses "Send funds"; every send names Sepolia;
//   C14  the page URL and the sponsor see the public swap id, never the salt; the prompt warns.

import { expect, test, type Page } from '@playwright/test';
import { concat, getAddress, keccak256, toUtf8Bytes } from 'ethers';

import {
  STKA,
  USDC,
  connect,
  fundSwap,
  serveApp,
  stage,
  startAskSwap,
  typedDataCalls,
  withWallet,
} from './fixtures.js';

const SWEEP_WEI = 65_000n * 2_500_000_000n;
const transfer = (to: string, amount: bigint) =>
  `0xa9059cbb${to.toLowerCase().replace(/^0x/, '').padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;

const mockRequests = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __emtMock: { requests(): Array<{ method: string; path: string }> } }).__emtMock.requests(),
  );

/** The swap records this page stored (key and parsed value). */
const storedSwaps = (page: Page) =>
  page.evaluate(() =>
    Object.entries({ ...localStorage })
      .filter(([k]) => k.startsWith('evm-midnight-transparent/') && k.includes('/swap/'))
      .map(([k, v]) => ({ key: k, value: JSON.parse(v) as { data: Record<string, unknown> } })),
  );

test('C1: a withdrawal start that fails after the sponsor accepted it is rebuilt and resubmitted', async ({ page }) => {
  await withWallet(page);
  await serveApp(page, { scenario: { failFirstStart: true } });
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await fundSwap(page);
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 40_000 });
  await expect(page.getByTestId('refunds')).toContainText('1 earlier withdrawal was refunded or could not start');
  const withdraws = (await mockRequests(page)).filter((r) => r.method === 'POST' && r.path.endsWith('/withdraw'));
  expect(withdraws).toHaveLength(2);
  await expect(page.getByTestId('done-summary')).toContainText('You paid 1.04 USDC and received 100.00 stkA');
});

test('C5: a failed swap the sponsor can revive is resumed from the page and finishes', async ({ page }) => {
  const wallet = await withWallet(page);
  await serveApp(page, { stepMs: 200 });
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await expect(page.getByTestId('send-funds')).toBeVisible();
  // The funds did not arrive in time: the sponsor fails the swap, recoverable.
  await page.evaluate(() =>
    (window as unknown as { __emtMock: { failAwaitingFunds(r: boolean): void } }).__emtMock.failAwaitingFunds(true),
  );
  await expect(page.getByTestId('swap-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('can-resume')).toBeVisible();
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'failed');

  // "Your swaps" offers Resume for it.
  await page.goto('/#swap');
  const row = page.locator('[data-testid=swap-record][data-phase=failed]');
  await expect(row).toContainText('Failed: can be resumed');
  const before = typedDataCalls(wallet).length;
  await row.getByTestId('record-resume').click();
  await expect(page.getByTestId('send-funds')).toBeVisible({ timeout: 15_000 });
  expect(
    typedDataCalls(wallet)
      .slice(before)
      .map((t) => t.primaryType),
  ).toEqual(['StartSwap', 'SponsorAction']);
  await fundSwap(page);
  await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 40_000 });
});

test('C8: an edited swap record cannot change what Send funds sends', async ({ page }) => {
  const wallet = await withWallet(page);
  await serveApp(page, { stepMs: 200 });
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await expect(page.getByTestId('send-funds')).toBeVisible();
  const deposit = getAddress((await page.getByTestId('deposit-address').getAttribute('data-value'))!);

  // The stored record's funding block edited (as an edited export would be), then a fresh load.
  await page.evaluate(
    ({ stka }) => {
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith('evm-midnight-transparent/') || !k.includes('/swap/')) continue;
        const v = JSON.parse(localStorage.getItem(k)!);
        v.data.deposit = {
          ...v.data.deposit,
          erc20Address: stka,
          amount: '999000000',
          sweepGas: { gasLimit: '1000000', maxFeePerGas: '3000000000', ethWei: '3000000000000000' },
        };
        localStorage.setItem(k, JSON.stringify(v));
      }
    },
    { stka: STKA },
  );
  await page.reload();
  await connect(page);
  // The swap's page, not running in this fresh tab: Resume.
  await expect(page.getByTestId('resume-here')).toBeVisible();
  await page.getByTestId('resume').click();
  await expect(page.getByTestId('send-funds')).toBeEnabled({ timeout: 15_000 });
  // The page shows, and sends, only what the sponsor said and it checked.
  await expect(page.getByTestId('funding-eth')).toContainText('0.0001625 ETH');
  await fundSwap(page);
  await expect.poll(() => wallet.sent.length).toBe(2);
  expect(wallet.sent[0]).toMatchObject({ to: deposit, value: SWEEP_WEI, data: '' });
  expect(wallet.sent[1]).toMatchObject({ to: USDC, value: 0n, data: transfer(deposit, 1_040_000n) });
  const [rec] = await storedSwaps(page);
  expect(rec!.value.data.deposit).toMatchObject({ erc20Address: USDC, amount: '1040000' });
});

test('C9: the wallet leaving Sepolia pauses Send funds; every send names Sepolia', async ({ page }) => {
  const wallet = await withWallet(page);
  await serveApp(page, { stepMs: 200 });
  await page.goto('/#swap');
  await connect(page);
  await startAskSwap(page);
  await expect(page.getByTestId('send-funds')).toBeEnabled();
  await wallet.setChain('0x1');
  await expect(page.getByTestId('funding-paused')).toContainText('funding is paused');
  await expect(page.getByTestId('send-funds')).toBeDisabled();
  expect(wallet.sent).toEqual([]);
  await wallet.setChain('0xaa36a7');
  await expect(page.getByTestId('funding-paused')).toHaveCount(0);
  await fundSwap(page);
  await expect.poll(() => wallet.sent.length).toBe(2);
  const sends = wallet.calls.filter((c) => c.method === 'eth_sendTransaction');
  for (const c of sends) expect((c.params as Array<Record<string, unknown>>)[0]).toMatchObject({ chainId: '0xaa36a7' });
  // Each send asked the wallet for its network and account first.
  const methods = wallet.calls.map((c) => c.method);
  const firstSend = methods.indexOf('eth_sendTransaction');
  expect(methods.slice(0, firstSend)).toEqual(expect.arrayContaining(['eth_chainId', 'eth_accounts']));
});

test('C14: the URL and the sponsor see the public swap id, never the salt; the prompt warns', async ({ page }) => {
  const wallet = await withWallet(page);
  await serveApp(page, { stepMs: 200 });
  await page.goto('/#swap');
  await connect(page);
  await expect(page.getByTestId('feed-status')).toHaveAttribute('data-status', 'ready');
  await page
    .locator('[data-testid=offer-row][data-pay=USDC][data-receive=stkA]')
    .filter({ hasText: '1.04' })
    .getByTestId('offer-swap')
    .click();
  await expect(page.getByTestId('start-swap-warning')).toContainText('Only sign');
  await page.getByTestId('start-swap').click();
  await expect(page.getByTestId('send-funds')).toBeVisible();

  const [start] = typedDataCalls(wallet);
  const salt = String(start!.message.salt);
  expect(String(start!.message.purpose)).toMatch(/^Start or resume a swap\. WARNING:/);
  const id = keccak256(concat([toUtf8Bytes('evm-midnight-swap/id'), salt])).toLowerCase();
  // The page's URL and the sponsor's requests carry the public id; nothing carries the salt.
  expect(new URL(page.url()).hash).toBe(`#swap?id=${id}`);
  const paths = (await mockRequests(page)).map((r) => r.path);
  expect(paths.some((p) => p.includes(id))).toBe(true);
  for (const p of paths) expect(p).not.toContain(salt.slice(2));
  const [open] = typedDataCalls(wallet).filter((t) => t.primaryType === 'SponsorAction');
  expect(open!.message.swap).toBe(id);
  // The salt is only in this browser's own record, next to the id.
  const [rec] = await storedSwaps(page);
  expect(rec!.value.data).toMatchObject({ swapId: id, salt, derivation: 2 });
  expect(rec!.key).toContain(id.slice(2));
  expect(rec!.key).not.toContain(salt.slice(2));
  await expect(stage(page, 'fund')).toHaveAttribute('data-state', 'current');
});

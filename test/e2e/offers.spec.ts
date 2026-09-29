// Plan L-WEB: the offers list, against the mock exchange (its HTTP API and SSE stream, served in the
// page from the mock book: the stagenet ladders' shape, plus offers the app must leave out).
//
//   - every live offer whose two legs are vault tokens, no token rules (a stkB → stkA row, no USDC);
//   - not the offer expiring within 45 minutes, nor an unshielded, a foreign-colour or a basket one;
//   - each row: you pay, you receive, the exact price both ways, the expiry;
//   - live updates: an offer taken elsewhere leaves the list without a reload (the offer stream);
//   - "exchange unavailable" when the kernel answers 503, and back when it recovers;
//   - an empty book; nothing leaves the page in mock mode.

import { expect, test } from '@playwright/test';

import { askRow, connect, serveApp, watchExternal, withWallet } from './fixtures.js';

test('the offers list: swappable, long-lived offers only, each with pay, receive, price and expiry', async ({
  page,
}) => {
  const external = watchExternal(page);
  await serveApp(page);
  await page.goto('/#swap');
  await expect(page.getByTestId('connect-first')).toBeVisible();
  await expect(page.getByTestId('feed-status')).toHaveAttribute('data-status', 'ready');
  await expect(page.getByTestId('feed-status')).toHaveAttribute('data-stream', 'live');

  const rows = page.getByTestId('offer-row');
  await expect(rows).toHaveCount(8);
  await expect(page.getByTestId('offers-note')).toHaveText(
    '8 offers · 1 expiring within 45 minutes not shown (a swap takes about 20) · 3 the bridge cannot carry not shown',
  );
  const pairs = await rows.evaluateAll((trs) =>
    trs.map((tr) => `${tr.getAttribute('data-pay')}>${tr.getAttribute('data-receive')}`),
  );
  expect(pairs.sort()).toEqual(
    ['stkA>USDC', 'stkA>USDC', 'stkB>USDC', 'stkB>stkA', 'USDC>TBILL', 'USDC>stkA', 'USDC>stkA', 'USDC>stkB'].sort(),
  );

  // One row, field by field: pay 1.04 USDC (bridged in as wUSDC), receive 100 stkA, 0.0104 USDC per stkA.
  const ask = askRow(page);
  await expect(ask.getByTestId('offer-pay')).toContainText('1.04USDC');
  await expect(ask.getByTestId('offer-pay')).toContainText('as wUSDC');
  await expect(ask.getByTestId('offer-receive')).toContainText('100.00stkA');
  await expect(ask.getByTestId('offer-price')).toContainText('0.0104 USDC');
  await expect(ask.getByTestId('offer-price')).toContainText('per stkA · 96.153846 stkA per USDC');
  await expect(ask.getByTestId('offer-expires')).toHaveText(/^in 1[12] d \d+ h$/);
  // Grouped by what you pay and receive, the lowest price first.
  const stkaAsks = page.locator(
    '[data-testid=offer-row][data-pay=USDC][data-receive=stkA] [data-testid=offer-price] .num',
  );
  await expect(stkaAsks).toHaveText(['0.0104 USDC', '0.0108 USDC']);

  // No token rules: two vault tokens without USDC.
  await expect(page.locator('[data-testid=offer-row][data-pay=stkB][data-receive=stkA]')).toHaveCount(1);
  expect(external).toEqual([]);
});

test('live updates: an offer taken elsewhere leaves the list, and the exchange going down shows', async ({ page }) => {
  await serveApp(page);
  await page.goto('/#swap');
  await expect(page.getByTestId('offer-row')).toHaveCount(8);
  await expect(page.getByTestId('feed-status')).toHaveAttribute('data-stream', 'live');
  const id = await askRow(page).getAttribute('data-offer-id');
  await page.evaluate(
    (offerId) =>
      (window as unknown as { __emtMock: { consumeOffer(id: string): void } }).__emtMock.consumeOffer(offerId!),
    id,
  );
  // The offer stream says offer_consumed; the feed refreshes on its own (no reload).
  await expect(page.getByTestId('offer-row')).toHaveCount(7);
  await expect(page.locator(`[data-offer-id="${id}"]`)).toHaveCount(0);

  await page.evaluate(() =>
    (window as unknown as { __emtMock: { setKernelDown(s: number | null): void } }).__emtMock.setKernelDown(503),
  );
  await page.getByTestId('feed-refresh').click();
  await expect(page.getByTestId('exchange-unavailable')).toBeVisible();
  await expect(page.getByTestId('offer-row')).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { __emtMock: { setKernelDown(s: number | null): void } }).__emtMock.setKernelDown(null),
  );
  await page.getByTestId('feed-refresh').click();
  await expect(page.getByTestId('offer-row')).toHaveCount(7);
});

test('an empty book', async ({ page }) => {
  await serveApp(page, { book: 'empty' });
  await page.goto('/#swap');
  await expect(page.getByTestId('offers-empty')).toBeVisible();
  await expect(page.getByTestId('offers-note')).toHaveText('0 offers');
});

test('a review before connecting: Start swap waits for the wallet', async ({ page }) => {
  await withWallet(page);
  await serveApp(page);
  await page.goto('/#swap');
  await askRow(page).getByTestId('offer-swap').click();
  await expect(page.getByTestId('review-pay')).toContainText('1.04USDC');
  await expect(page.getByTestId('review-receive')).toContainText('100.00stkA');
  await expect(page.getByTestId('start-blocker')).toHaveText('Connect your wallet to swap.');
  await expect(page.getByTestId('start-swap')).toBeDisabled();
  await connect(page);
  await expect(page.getByTestId('review-holdings')).toContainText('50.00 USDC');
  await expect(page.getByTestId('start-swap')).toBeEnabled();
});

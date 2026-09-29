// Plan L-WEB: the pages at 1280 px and at 375 px (a touch phone): no horizontal page scroll, no
// element wider than the page, buttons at least 44 px tall on the phone, and every text at WCAG AA
// contrast as rendered. A screenshot of each page goes to $VISUAL_OUT_DIR (default
// test-results/visual). The token pairs themselves are checked by web/test/design-contrast.test.ts.

import { expect, test, type Page } from '@playwright/test';

import {
  assertContrast,
  assertLayout,
  bridgeInStagesAtLeast,
  connect,
  fundSwap,
  serveApp,
  setMockStep,
  shot,
  stage,
  startAskSwap,
  withWallet,
} from './fixtures.js';

const VIEWPORTS = [
  { name: 'desktop1280', width: 1280, height: 900, touch: false },
  { name: 'phone375', width: 375, height: 812, touch: true },
] as const;

async function check(page: Page, touch: boolean, name: string, fullPage = true) {
  await assertLayout(page, touch);
  await assertContrast(page);
  await shot(page, name, fullPage);
}

for (const vp of VIEWPORTS) {
  test.describe(`layout at ${vp.width} px`, () => {
    test.use({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.touch,
      isMobile: vp.touch,
      deviceScaleFactor: vp.touch ? 2 : 1,
    });

    test('offers, review, a swap in progress, done, and Local data', async ({ page }) => {
      await withWallet(page);
      await serveApp(page, { stepMs: 200 });
      await page.goto('/#swap');
      await expect(page.getByTestId('offer-row')).toHaveCount(8);
      await check(page, vp.touch, `${vp.name}-offers-disconnected`);
      await connect(page);
      await check(page, vp.touch, `${vp.name}-offers`);

      await startAskSwap(page);
      await expect(page.getByTestId('send-funds')).toBeVisible();
      await check(page, vp.touch, `${vp.name}-swap-fund`);
      await fundSwap(page);
      await bridgeInStagesAtLeast(page, 3);
      await setMockStep(page, 600_000); // hold the swap mid-bridge-in while the page is checked
      await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'bridging-in');
      await check(page, vp.touch, `${vp.name}-swap-bridging-in`);
      await setMockStep(page, 100);
      await expect(page.getByTestId('swap-page')).toHaveAttribute('data-phase', 'done', { timeout: 40_000 });
      await check(page, vp.touch, `${vp.name}-swap-done`);

      await page.goto('/#swap');
      await expect(page.getByTestId('your-swaps')).toBeVisible();
      await check(page, vp.touch, `${vp.name}-your-swaps`);
      await page.getByTestId('tab-local').click();
      await expect(page.locator('[data-testid=record-row][data-kind=swap]')).toHaveCount(1);
      await check(page, vp.touch, `${vp.name}-local-data`);
    });

    test('the review of an offer', async ({ page }) => {
      await withWallet(page);
      await serveApp(page);
      await page.goto('/#swap');
      await connect(page);
      await expect(page.getByTestId('feed-status')).toHaveAttribute('data-status', 'ready');
      await page
        .locator('[data-testid=offer-row][data-pay=USDC][data-receive=stkA]')
        .filter({ hasText: '1.04' })
        .getByTestId('offer-swap')
        .click();
      await expect(page.getByTestId('review-holdings')).toBeVisible();
      await check(page, vp.touch, `${vp.name}-review`);
    });

    test('"Swap is not available"', async ({ page }) => {
      await withWallet(page);
      await serveApp(page, { stepMs: 100, scenario: { offerGoneAtTake: true } });
      await page.goto('/#swap');
      await connect(page);
      await startAskSwap(page);
      await fundSwap(page);
      await expect(page.getByTestId('not-available')).toBeVisible({ timeout: 30_000 });
      await expect(stage(page, 'take')).toHaveAttribute('data-state', 'failed');
      await check(page, vp.touch, `${vp.name}-swap-not-available`);
    });

    // Layout checks run before the screenshot: a full-page capture can reset the touch emulation.
    test('the determinism warning', async ({ page }) => {
      await withWallet(page, { nonDeterministic: true });
      await serveApp(page);
      await page.goto('/#swap');
      await connect(page);
      await startAskSwap(page);
      await expect(page.getByTestId('nondet-dialog')).toBeVisible();
      await check(page, vp.touch, `${vp.name}-swap-nondeterministic`, false);
    });
  });
}

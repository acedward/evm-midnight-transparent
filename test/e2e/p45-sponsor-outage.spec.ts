// Plan 00048 P4.5 (a), in the browser against the mock ports and the test wallet (found live in
// P4.2-live E.5: with the sponsor paused, its gateway answered 502 and the page showed "The swap
// stopped. the sponsor answered 502" with Retry; evidence p4-live/shot-e5-error-settled-elsewhere.png):
//
//   - the sponsor goes down mid-swap (a gateway's 502, then no answer at all) for longer than the old
//     page tolerated, and comes back: the page shows a quiet "The sponsor is not answering; still
//     trying", never "The swap stopped", never a Retry button, and the swap completes by itself;
//   - the same while the sponsor proves the take (its own coded 503 "try again") and while it
//     receives the withdrawal (a gateway's 504);
//   - the outage notice at 1280 and 375 px, with the rendered contrast.

import { expect, test, type Page } from '@playwright/test';

import {
  assertContrast,
  assertLayout,
  bridgeInStagesAtLeast,
  connect,
  fundSwap,
  serveApp,
  shot,
  startAskSwap,
  withWallet,
} from './fixtures.js';

const OUTAGE = 'The sponsor is not answering; still trying.';

type DownAnswer = number | 'network' | { status: number; code: string; message: string } | null;

const mock = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ({ fn, args }) =>
      (window as unknown as { __emtMock: Record<string, (...a: unknown[]) => unknown> }).__emtMock[fn]!(...args),
    { fn, args },
  ) as Promise<T>;

const down = (page: Page, answer: DownAnswer, only?: string) => mock<void>(page, 'setSponsorDown', answer, only);
const hits = (page: Page) => mock<number>(page, 'sponsorDownHits');
const swapPage = (page: Page) => page.getByTestId('swap-page');

/** Record, in the page, whether the swap ever showed a stop or a Retry button (a flash counts). */
async function watchForStops(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __emtStops: string[] };
    w.__emtStops = [];
    const look = () => {
      for (const id of ['swap-error', 'retry'])
        if (document.querySelector(`[data-testid=${id}]`) && !w.__emtStops.includes(id)) w.__emtStops.push(id);
      if (document.querySelector('[data-testid=swap-page][data-status=error]') && !w.__emtStops.includes('status'))
        w.__emtStops.push('status');
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true });
    look();
  });
}
const stops = (page: Page) => page.evaluate(() => (window as unknown as { __emtStops: string[] }).__emtStops);

/** Keep the sponsor down at least `ms` and until it refused `n` more requests; fails as soon as the
 *  swap shows a stop (the bug). */
async function outage(page: Page, answer: DownAnswer, opts: { ms: number; n: number; only?: string }): Promise<void> {
  const from = await hits(page);
  const t0 = Date.now();
  await down(page, answer, opts.only);
  const progress = async () => {
    const st = await stops(page);
    if (st.length > 0) return `the swap stopped (${st.join(', ')})`;
    return (await hits(page)) - from >= opts.n && Date.now() - t0 >= opts.ms ? 'waited it out' : 'down';
  };
  await expect.poll(progress, { timeout: 30_000, intervals: [100] }).toBe('waited it out');
}

test('the sponsor goes down mid-swap (502, then no answer) and comes back: a quiet notice, no stop, no Retry, the swap completes', async ({
  page,
}) => {
  await withWallet(page);
  await serveApp(page, { stepMs: 150 });
  await page.goto('/#swap');
  await watchForStops(page);
  await connect(page);
  await startAskSwap(page);
  await fundSwap(page);
  await bridgeInStagesAtLeast(page, 3);

  // A gateway's 502 for 4 s: the old page stopped after ten tries (about 1.5 s here).
  await outage(page, 502, { ms: 4_000, n: 4 });
  const notice = page.getByTestId('sponsor-outage');
  await expect(notice).toHaveText(OUTAGE);
  await expect(page.getByTestId('swap-error')).toHaveCount(0);
  await expect(page.getByTestId('retry')).toHaveCount(0);
  await expect(swapPage(page)).toHaveAttribute('data-phase', 'bridging-in');
  await expect(swapPage(page)).toHaveAttribute('data-status', 'working');
  await shot(page, 'p45-sponsor-outage-1280');
  await assertLayout(page, false);
  await assertContrast(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(notice).toBeVisible();
  await shot(page, 'p45-sponsor-outage-375');
  await assertLayout(page, true);
  await assertContrast(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Then no answer at all (the sponsor's host is unreachable) for 3 s more.
  await outage(page, 'network', { ms: 3_000, n: 2 });
  await expect(notice).toHaveText(OUTAGE);
  await expect(page.getByTestId('swap-error')).toHaveCount(0);

  // Back up: the swap goes on by itself; the notice goes away.
  await down(page, null);
  await expect(swapPage(page)).toHaveAttribute('data-phase', 'done', { timeout: 60_000 });
  await expect(swapPage(page)).toHaveAttribute('data-status', 'done');
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId('done-summary')).toContainText('You paid 1.04 USDC and received 100.00 stkA.');
  expect(await stops(page), 'never a stop, never a Retry button').toEqual([]);
});

test('the sponsor says "try again" while proving the take (503) and its gateway drops the withdrawal (504): waited out, the swap completes with no Retry', async ({
  page,
}) => {
  await withWallet(page);
  await serveApp(page, { stepMs: 150 });
  await page.goto('/#swap');
  await watchForStops(page);
  await connect(page);
  await startAskSwap(page);
  await fundSwap(page);

  // The take's proof: the sponsor's own coded 503 (the old page stopped at the first one).
  await outage(
    page,
    { status: 503, code: 'prover-unavailable', message: 'the proof server is not available' },
    { ms: 2_500, n: 3, only: '/prove' },
  );
  await expect(page.getByTestId('sponsor-outage')).toHaveText(
    'The sponsor cannot go on right now (the proof server is not available); still trying.',
  );
  await expect(page.getByTestId('swap-error')).toHaveCount(0);
  await expect(swapPage(page)).toHaveAttribute('data-phase', 'taking');

  // The withdrawal's submission: the gateway times out (504).
  await outage(page, 504, { ms: 2_000, n: 2, only: '/withdraw' });
  await expect(page.getByTestId('sponsor-outage')).toHaveText(OUTAGE);
  await expect(page.getByTestId('swap-error')).toHaveCount(0);
  await expect(swapPage(page)).toHaveAttribute('data-phase', 'bridging-out');

  await down(page, null);
  await expect(swapPage(page)).toHaveAttribute('data-phase', 'done', { timeout: 60_000 });
  await expect(page.getByTestId('sponsor-outage')).toHaveCount(0);
  await expect(page.getByTestId('done-summary')).toContainText('You paid 1.04 USDC and received 100.00 stkA.');
  expect(await stops(page), 'never a stop, never a Retry button').toEqual([]);
});

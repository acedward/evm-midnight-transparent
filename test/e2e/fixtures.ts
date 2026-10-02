// Shared steps for the browser specs: the site in mock mode (its config.json served by the spec), the
// test wallet, the swap steps, and the layout and contrast checks with screenshots.

import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, type Page } from '@playwright/test';

import { type FakeSepolia, type TestWallet, installTestWallet } from './test-wallet.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
export const VISUAL_OUT = process.env.VISUAL_OUT_DIR ?? `${root}/test-results/visual`;
mkdirSync(VISUAL_OUT, { recursive: true });

/** Sepolia addresses of the vault tokens the specs pay with (the vendored records). */
export const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
export const STKA = '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52';

export interface MockSettings {
  stepMs?: number;
  scenario?: {
    offerGoneAtTake?: boolean;
    refundFirstWithdrawal?: boolean;
    refuseOpen?: string;
    failFirstStart?: boolean;
    /** P4.2-fix4: the first withdrawal's Sepolia transfer (P4.2-fix5 U4: `foreign`, another
     *  withdrawal's); hold the bridge's closing after a transfer. */
    transferReceipt?: 'ok' | 'reverted' | 'wrong-token' | 'wrong-amount' | 'older' | 'foreign';
    holdAfterTransfer?: boolean;
  };
  book?: 'default' | 'empty';
  evmWallet?: boolean;
  persist?: boolean;
}

/** Serve config.json in mock mode (optionally with network overrides). */
export async function serveApp(
  page: Page,
  mock: MockSettings = {},
  overrides?: Record<string, unknown>,
): Promise<void> {
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: {
        network: 'stagenet',
        sponsorUrl: '',
        ...(overrides ? { overrides } : {}),
        mock: { stepMs: 120, evmWallet: false, persist: true, ...mock },
      },
    }),
  );
}

/** Requests that left the page's own origin (mock mode must make none). */
export function watchExternal(page: Page): string[] {
  const out: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('http://127.0.0.1:') && !u.startsWith('data:') && !u.startsWith('blob:')) out.push(u);
  });
  return out;
}

export function richWallet(): FakeSepolia {
  return {
    ethWei: 10n ** 17n,
    erc20: { [USDC.toLowerCase()]: 50_000_000n, [STKA.toLowerCase()]: 1_000_000_000n },
  };
}

export async function withWallet(page: Page, opts: Parameters<typeof installTestWallet>[1] = {}): Promise<TestWallet> {
  return installTestWallet(page, { sepolia: richWallet(), ...opts });
}

export async function connect(page: Page): Promise<void> {
  await page.getByTestId('connect').click();
  await page.getByTestId('wallet-option').filter({ hasText: 'EMT Test Wallet' }).click();
  await expect(page.getByTestId('wallet-chain')).toHaveText('Sepolia');
}

/** The mock book's "you pay 1.04 USDC, you receive 100 stkA" row. */
export const askRow = (page: Page) =>
  page.locator('[data-testid=offer-row][data-pay=USDC][data-receive=stkA]').filter({ hasText: '1.04' });

export const stage = (page: Page, key: string) => page.locator(`[data-testid=swap-stage][data-stage=${key}]`);

/** The mock sponsor's step time: a long one freezes the swap where it is (for layout checks on a
 *  slow machine), a short one lets it run on. */
export const setMockStep = (page: Page, ms: number) =>
  page.evaluate(
    (m) => (window as unknown as { __emtMock: { setStepMs(ms: number): void } }).__emtMock.setStepMs(m),
    ms,
  );

/** Wait until the bridge-in shows at least `n` of the sponsor's stages. */
export const bridgeInStagesAtLeast = (page: Page, n: number) =>
  expect
    .poll(() => page.getByTestId('bridge-in-stages').locator('li').count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(n);

/** Open the review of the 1.04 USDC → 100 stkA offer and start the swap: to the funding step. */
export async function startAskSwap(page: Page): Promise<void> {
  await expect(page.getByTestId('feed-status')).toHaveAttribute('data-status', 'ready');
  await askRow(page).getByTestId('offer-swap').click();
  await expect(page.getByTestId('review-swap')).toBeVisible();
  await page.getByTestId('start-swap').click();
}

export async function fundSwap(page: Page): Promise<void> {
  await expect(page.getByTestId('send-funds')).toBeEnabled();
  await page.getByTestId('send-funds').click();
}

export const typedDataCalls = (w: TestWallet) =>
  w.calls
    .filter((c) => c.method === 'eth_signTypedData_v4')
    .map(
      (c) =>
        JSON.parse(String((c.params as unknown[])[1])) as { primaryType: string; message: Record<string, unknown> },
    );

/** Layout checks that must hold on every page, at every width (from MN Bank's visual spec). */
export async function assertLayout(page: Page, touch: boolean): Promise<void> {
  const r = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const scrollBox = (el: Element | null): boolean => {
      for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
        const o = getComputedStyle(p).overflowX;
        if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true;
      }
      return false;
    };
    const wide: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (el.closest('dialog:not([open])')) continue;
      if ((b.right > vw + 0.5 || b.left < -0.5) && !scrollBox(el))
        wide.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} ${Math.round(b.left)}–${Math.round(b.right)}`,
        );
    }
    const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, a.btn'))
      .filter((b) => b.getBoundingClientRect().height > 0 && !b.closest('.hash') && !b.classList.contains('btn-link'))
      .map((b) => ({
        text: (b.textContent ?? '').trim().slice(0, 30),
        h: b.getBoundingClientRect().height,
        small: b.classList.contains('btn-small'),
      }));
    return { scrollWidth: document.documentElement.scrollWidth, vw, wide, buttons };
  });
  expect(r.wide, 'no element wider than the page').toEqual([]);
  expect(r.scrollWidth, 'no horizontal page scroll').toBeLessThanOrEqual(r.vw);
  for (const b of r.buttons) {
    if (touch || !b.small) expect(b.h, `button "${b.text}" is at least 44 px tall`).toBeGreaterThanOrEqual(44);
  }
}

/**
 * The rendered contrast of every visible text (WCAG 2.2 AA: 4.5:1, 3:1 for large text), computed from
 * each text's colour and the background it actually sits on (the design system's token pairs are
 * checked one by one in web/test/design-contrast.test.ts; this checks what the pages put together).
 */
export async function assertContrast(page: Page): Promise<void> {
  const failures = await page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return [0, 0, 0, 0];
      const p = m[1]!
        .split(/[ ,/]+/)
        .filter(Boolean)
        .map(Number);
      return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
    };
    const over = (top: number[], under: number[]) => {
      const a = top[3]!;
      return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a)).concat(1);
    };
    const lum = (c: number[]) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const background = (el: Element): number[] => {
      const layers: number[][] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const bg = parse(getComputedStyle(e).backgroundColor);
        if (bg[3] > 0) layers.push(bg);
        if (bg[3] >= 1) break;
      }
      let c = [255, 255, 255, 1];
      for (const l of layers.reverse()) c = over(l, c);
      return c;
    };
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');
      if (!own) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 1 || r.height <= 1 || el.closest('dialog:not([open]), .sr-only')) continue;
      let hidden = false;
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 1) hidden = true;
      }
      if (hidden) continue;
      const s = getComputedStyle(el);
      const bg = background(el);
      const fg = over(parse(s.color), bg);
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      const ratio = (a! + 0.05) / (b! + 0.05);
      const size = parseFloat(s.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5) - 0.01)
        out.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}" ${ratio.toFixed(2)}:1`);
    }
    return out;
  });
  expect(failures, 'every text meets WCAG AA contrast').toEqual([]);
}

export async function shot(page: Page, name: string, fullPage = true): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${VISUAL_OUT}/${name}.png`, fullPage, animations: 'disabled' });
}

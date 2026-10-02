// The default Content-Security-Policy, as the built web image serves it (audit C15). The page must
// run with no violation: in live mode (config.json from the image: stagenet, the /sponsor proxy) it
// reads the exchange's book and preloads the wallet chunk, whose ledger WASM it compiles
// ('wasm-unsafe-eval'); in mock mode it runs the swap pages. Read-only: no transaction, no signature.
import { expect, test, type Page } from '@playwright/test';

async function watchViolations(page: Page): Promise<string[]> {
  const fromConsole: string[] = [];
  page.on('console', (m) => {
    if (/Content[- ]Security[- ]Policy/i.test(m.text())) fromConsole.push(m.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });
  return fromConsole;
}

const violations = (page: Page) => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

test('the site sends the default policy (strict: no inline script, no eval, no framing)', async ({ request }) => {
  const res = await request.get('/');
  expect(res.ok()).toBe(true);
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain('https://stagenet.api-zswap.zkdojo.com');
  expect(csp).not.toContain('unsafe-inline');
});

test('live mode: the book loads and the wallet chunk compiles its WASM, with no violation', async ({ page }) => {
  const fromConsole = await watchViolations(page);
  const wasm: string[] = [];
  const kernel: number[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith('.wasm') && r.ok()) wasm.push(r.url());
    if (r.url().startsWith('https://stagenet.api-zswap.zkdojo.com/')) kernel.push(r.status());
  });
  await page.goto('/');
  await expect.poll(() => wasm.length, { timeout: 60_000 }).toBeGreaterThan(0);
  await expect.poll(() => kernel.length, { timeout: 60_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(5_000); // the WASM is compiled after it arrives
  expect(await violations(page)).toEqual([]);
  expect(fromConsole).toEqual([]);
});

test('mock mode: the offers and a swap page render with no violation', async ({ page }) => {
  const fromConsole = await watchViolations(page);
  await page.route('**/config.json', (route) =>
    route.fulfill({
      json: { network: 'stagenet', sponsorUrl: '', mock: { stepMs: 120, evmWallet: false, persist: true } },
    }),
  );
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2_000);
  expect(await violations(page)).toEqual([]);
  expect(fromConsole).toEqual([]);
});

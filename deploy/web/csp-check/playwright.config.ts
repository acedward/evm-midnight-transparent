// The web bundle's default Content-Security-Policy in a real browser (audit C15): the repository's
// browser specs (test/e2e, mock mode) plus ./csp.spec.ts, all against the BUILT web image, which
// serves its default policy. Run by ../csp-browser-check.sh inside the Playwright image, in the web
// container's network namespace (so the site is http://127.0.0.1:8080). Not part of CI: it needs the
// image.
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const root = fileURLToPath(new URL('../../..', import.meta.url));

export default defineConfig({
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: `${root}/test-results/csp-check`,
  use: { baseURL: 'http://127.0.0.1:8080', trace: 'retain-on-failure' },
  projects: [
    { name: 'csp', testDir: '.', testMatch: /csp\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
    { name: 'e2e', testDir: `${root}/test/e2e`, testMatch: /.*\.spec\.ts$/, use: { ...devices['Desktop Chrome'] } },
  ],
});

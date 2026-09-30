// Plan 00048 P3 (live end-to-end, Q8 caps): Playwright against the DEPLOYED bundle's web container
// (deploy/compose.yml), never a dev server. The runner shares the web container's network namespace
// (test/live/run-live.sh phase), so the site is http://127.0.0.1:8080 (a secure context) and the
// sponsor is its same-origin /sponsor/ proxy, as a user behind the reverse proxy sees them.
// Never run by CI: the specs skip without the live-run files.
import { fileURLToPath } from 'node:url';

import { defineConfig, devices } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  testDir: '.',
  testMatch: /swap-live\.spec\.ts$/,
  timeout: 150 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: `${root}/test-results/live`,
  use: {
    baseURL: process.env.LIVE_BASE_URL ?? 'http://127.0.0.1:8080',
    // No traces or videos: the page never holds a secret, but the runner's key must not be near one.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    actionTimeout: 60_000,
    viewport: { width: 1280, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
});

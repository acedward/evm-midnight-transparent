import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

// The T.5 harness page: the temporary wallet's own code (packages/wallet), bundled for the browser.
// Built into test-results/ (git-ignored) and served by browser-run.ts inside the Playwright image.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: {
    target: 'esnext',
    outDir: fileURLToPath(new URL('../../../../test-results/g-take-browser', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 20000,
  },
});

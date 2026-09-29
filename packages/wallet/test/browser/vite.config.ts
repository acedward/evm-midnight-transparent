import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';

// L-WALLET's headless-browser page: the wallet module (packages/wallet) bundled for the browser with
// NO Vite plugins, as the web app will bundle it (the ledger and runtime WASM are emitted as assets).
// Built into test-results/ (git-ignored) and served by run.ts inside the Playwright image.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: {
    target: 'esnext',
    outDir: fileURLToPath(new URL('../../../../test-results/wallet-browser', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 20000,
  },
});

import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

import { APP_NAME } from './src/brand.js';

/** The app's name lives in ONE constant (src/brand.ts, questions Q10): index.html takes it from there. */
function appName(): Plugin {
  const escaped = APP_NAME.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return { name: 'app-name', transformIndexHtml: (html) => html.replaceAll('%APP_NAME%', escaped) };
}

// The web app is a static site: it bundles @evm-midnight-transparent/core and nothing that needs
// Node. The in-browser Midnight wallet (packages/wallet, with the ledger and runtime WASM) is a
// separate chunk loaded on first use (src/swap/wiring.ts); Vite bundles it with no plugins (the
// WASM files are emitted as assets), as G-TAKE T.5 and L-WALLET LW.4 did.
export default defineConfig({
  plugins: [react(), appName()],
  base: './',
  // Keep JSON as per-field exports (never one JSON.parse blob), so the bundle carries only the
  // fields of the vendored deployment records that the code actually imports.
  json: { namedExports: true, stringify: false },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 2000,
  },
  server: { host: '127.0.0.1', strictPort: true },
  preview: { host: '127.0.0.1', strictPort: true },
});

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The web app is a static site: it bundles @evm-midnight-transparent/core and nothing that needs
// Node. TODO(L-WALLET): the in-browser Midnight wallet SDK (WASM) will need its own bundling notes.
export default defineConfig({
  plugins: [react()],
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

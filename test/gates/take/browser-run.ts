// G-TAKE T.5 driver: headless Chromium (the Playwright image) runs the temporary wallet's code.
//
// Bundled for Node by run-gate.sh (`bun build --target=node`) and run with Node inside
// mcr.microsoft.com/playwright:v1.62.0-noble on the gate's Docker network, so the page reaches the
// proof server by its container name: a real cross-origin request, which is what T.5 checks (CORS).
//
// The driver derives the swap seed exactly as the gate does (the test EVM key signs "start swap"
// twice, in-process; the salt is the gate's public one), serves the harness page, and hands the
// seed to the page's memory. Nothing secret is printed or written; the evidence is public numbers.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import * as path from 'node:path';

import { Wallet } from 'ethers';
import { chromium } from 'playwright-core';

import { STAGENET, deriveSwapSeed, type StartSwapSigner } from '../../../packages/core/src/index.js';

const env = (k: string, d: string) => process.env[k] || d;
const DIST = env('HARNESS_DIST', '/app/test-results/g-take-browser');
const OUT = env('GATE_EVIDENCE_DIR', '/out');
const STATE_FILE = path.join(env('GATE_STATE_DIR', '/state'), 'g-take-state.json');
const SEPOLIA_SECRET = env('SEPOLIA_SECRET_FILE', '/run/secrets/sepolia');
const PROOF = env('PROOF_SERVER_URL', 'http://aa00048-gt-prover:6300');

const say = (msg: string, fields: Record<string, unknown> = {}) =>
  process.stderr.write(
    `[g-take-browser ${new Date().toISOString()}] ${msg}${Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''}\n`,
  );

function sepoliaKey(): string {
  const text = readFileSync(SEPOLIA_SECRET, 'utf8');
  let value = text.trim();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(SK|PRIVATE_KEY)\s*=\s*(.*)$/.exec(line);
    if (m) value = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
  }
  const hex = value.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('the Sepolia secret file does not hold a 32-byte key');
  return `0x${hex}`;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
};

async function serve(): Promise<{ url: string; close(): void }> {
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!).replace(/^\/+/, '') || 'index.html';
    const file = path.join(DIST, path.normalize(rel));
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/index.html`, close: () => server.close() };
}

async function main(): Promise<void> {
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { salt?: string };
  if (!state.salt) throw new Error('run the gate derive step first (no salt)');
  const evm = new Wallet(sepoliaKey());
  const sign: StartSwapSigner = async (td) => {
    const { EIP712Domain: _domain, ...types } = td.types;
    return evm.signTypedData(td.domain, types, td.message);
  };
  const { seedHex, deterministic } = await deriveSwapSeed(
    sign,
    { network: STAGENET.midnightNetworkId, vault: STAGENET.bridge.vaultAddress, salt: state.salt },
    evm.address,
  );
  if (!deterministic) throw new Error('the test signer is not deterministic');

  const site = await serve();
  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  try {
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
    });
    page.on('requestfailed', (r) => failedRequests.push(`${r.url().slice(0, 120)}: ${r.failure()?.errorText ?? '?'}`));
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 300)}`));
    await page.goto(site.url);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', null, {
      timeout: 60_000,
    });
    say('harness page ready', { browser: browser.version() });
    const t0 = Date.now();
    const result = (await page.evaluate(
      (input) => (window as unknown as { gateRun(i: unknown): Promise<Record<string, unknown>> }).gateRun(input),
      { seedHex, proofServerUrl: PROOF },
    )) as Record<string, unknown>;
    const evidence = {
      gate: 'G-TAKE',
      plan: '00048',
      step: 't5-browser',
      at: new Date().toISOString(),
      chromium: browser.version(),
      harness: 'test/gates/take/browser (packages/wallet bundled by Vite 8)',
      totalSeconds: Math.round((Date.now() - t0) / 100) / 10,
      ...result,
      consoleErrors: consoleErrors.slice(0, 20),
      failedRequests: failedRequests.slice(0, 20),
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, 't5-browser.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    say('T.5 browser', evidence);
  } finally {
    await browser.close();
    site.close();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    say('FAILED', { error: String((e as Error)?.message ?? e) });
    process.exit(1);
  },
);

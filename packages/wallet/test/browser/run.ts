// L-WALLET's headless-browser check, the driver: Chromium (the Playwright image) loads the wallet
// module's page (main.ts, built by Vite) and runs it once against stagenet, READ-ONLY.
//
//   bash packages/wallet/test/browser/run.sh          (builds, then runs this inside the image)
//
// The page's injected EVM wallet (`window.ethereum`) answers `eth_signTypedData_v4` here, with a
// PUBLIC test key (core's start-swap test vector key: keccak256 of a label, never funded). The driver
// records every request the page makes (HTTP and WebSocket frames) and checks:
//   - the page reached only the stagenet indexer and the exchange's kernel (no proof server, no
//     batcher, no sponsor: nothing is proven or submitted);
//   - neither the swap seed nor either signature ever left the page (re-derived here from the salt
//     the page reports, then searched for in every URL, request body and WebSocket frame sent);
//   - the wallet derived deterministically, synced, refused the take it cannot pay, built a take for
//     a live offer and a startWithdraw on the vault's live state, and closed.
// The evidence (public numbers only) goes to $OUT/browser.json.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import * as path from 'node:path';

import { Wallet, keccak256, toUtf8Bytes } from 'ethers';
import { chromium } from 'playwright-core';

import { STAGENET, deriveSwapSeed, startSwapTypedData } from '../../../core/src/index.js';

const env = (k: string, d: string) => process.env[k] || d;
const DIST = env('HARNESS_DIST', '/app/test-results/wallet-browser');
const OUT = env('EVIDENCE_DIR', '/out');
const RUN_TIMEOUT_MS = Number(env('RUN_TIMEOUT_MS', '600000'));

/** core's PUBLIC start-swap test vector key (packages/core/test/swap-key.test.ts): never funded. */
const EVM = new Wallet(keccak256(toUtf8Bytes('evm-midnight-transparent: start-swap test vector 1')));
const ALLOWED_HOSTS = new Set([
  '127.0.0.1',
  new URL(STAGENET.midnight.indexerUrl).hostname,
  new URL(STAGENET.midnight.indexerWsUrl).hostname,
  new URL(STAGENET.zswap.kernelUrl).hostname,
]);

const say = (msg: string, fields: Record<string, unknown> = {}) =>
  process.stderr.write(
    `[l-wallet-browser ${new Date().toISOString()}] ${msg}${Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''}\n`,
  );

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.wasm': 'application/wasm',
  '.css': 'text/css',
};

async function serve(): Promise<{ url: string; close(): void; bytes: Record<string, number> }> {
  const bytes: Record<string, number> = {};
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!).replace(/^\/+/, '') || 'index.html';
    const file = path.join(DIST, path.normalize(rel));
    if (!file.startsWith(DIST) || !existsSync(file)) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = readFileSync(file);
    bytes[rel] = body.length;
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/index.html`, close: () => server.close(), bytes };
}

async function sign(address: string, typedDataJson: string): Promise<string> {
  if (address.toLowerCase() !== EVM.address.toLowerCase()) throw new Error('unknown account');
  const td = JSON.parse(typedDataJson) as ReturnType<typeof startSwapTypedData>;
  const { EIP712Domain: _domain, ...types } = td.types;
  return EVM.signTypedData(td.domain, types, td.message);
}

interface Sent {
  kind: 'http' | 'ws';
  host: string;
  url: string;
  body: string;
}

async function main(): Promise<void> {
  const site = await serve();
  const browser = await chromium.launch({ headless: true });
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const sent: Sent[] = [];
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) failures.push(what);
  };
  try {
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 300)}`));
    page.on('requestfailed', (r) => failedRequests.push(`${r.url().slice(0, 120)}: ${r.failure()?.errorText ?? '?'}`));
    page.on('request', (r) =>
      sent.push({ kind: 'http', host: new URL(r.url()).hostname, url: r.url(), body: r.postData() ?? '' }),
    );
    page.on('websocket', (ws) => {
      const host = new URL(ws.url()).hostname;
      sent.push({ kind: 'ws', host, url: ws.url(), body: '' });
      ws.on('framesent', (f) => sent.push({ kind: 'ws', host, url: ws.url(), body: String(f.payload) }));
    });
    await page.exposeFunction('__evmSign', sign);
    await page.addInitScript(() => {
      const w = window as unknown as { __evmSign(a: string, td: string): Promise<string> };
      (window as unknown as { ethereum: unknown }).ethereum = {
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          if (method !== 'eth_signTypedData_v4') throw new Error(`unsupported: ${method}`);
          return w.__evmSign(String(params![0]), String(params![1]));
        },
      };
    });
    await page.goto(site.url);
    await page.waitForFunction(() => document.getElementById('status')?.textContent === 'ready', null, {
      timeout: 60_000,
    });
    say('page ready', { chromium: browser.version() });
    const t0 = Date.now();
    const result = (await Promise.race([
      page.evaluate(
        (input) => (window as unknown as { walletRun(i: unknown): Promise<Record<string, unknown>> }).walletRun(input),
        { evmAddress: EVM.address },
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('the run timed out')), RUN_TIMEOUT_MS)),
    ])) as Record<string, Record<string, unknown> | string | boolean>;
    const totalSeconds = Math.round((Date.now() - t0) / 100) / 10;

    // Re-derive the secrets from the public salt, and look for them in everything the page sent.
    const derive = result.derive as { salt: string; deterministic: boolean; signer: string };
    const params = { network: STAGENET.midnightNetworkId, vault: STAGENET.bridge.vaultAddress, salt: derive.salt };
    const { seedHex } = await deriveSwapSeed(async (td) => sign(EVM.address, JSON.stringify(td)), params, EVM.address);
    const signature = (await sign(EVM.address, JSON.stringify(startSwapTypedData(params)))).replace(/^0x/, '');
    const needles = [seedHex, signature, signature.slice(0, 64), signature.slice(64, 128)].map((n) => n.toLowerCase());
    const leaks = sent.filter((s) => needles.some((n) => `${s.url} ${s.body}`.toLowerCase().includes(n))).length;
    const hosts = [...new Set(sent.map((s) => s.host))].sort();

    const wallet = result.wallet as Record<string, unknown>;
    const take = result.take as Record<string, unknown>;
    const withdraw = result.withdraw as Record<string, unknown>;
    check(derive.deterministic === true && derive.signer === EVM.address, 'deterministic derivation by the test key');
    check(wallet.depositAddressMatchesCore === true, 'the deposit address equals core');
    check(Number(wallet.shieldedAddressChars) > 90, 'the shielded address is the long form');
    check(String(result.takeFromSyncedWallet).startsWith('insufficient-funds'), 'the empty wallet refuses the take');
    check(take.offerIdMatches === true && take.termsMatchTheBook === true, 'the take matches the live offer');
    check(
      Object.values(take.imbalances as Record<string, string>).every((v) => v !== '0'),
      'the take is the complement',
    );
    check(
      (withdraw.calls as string[]).length === 2 && withdraw.balanced === true,
      'startWithdraw: two calls, balanced',
    );
    check(String(result.withdrawSecondBuild).startsWith('insufficient-funds'), 'a booked coin is not spent twice');
    check(result.closed === true, 'the wallet closed');
    check(leaks === 0, 'no seed or signature left the page');
    check(
      hosts.every((h) => ALLOWED_HOSTS.has(h)),
      `only the indexer and the kernel were reached (${hosts.join(', ')})`,
    );
    check(consoleErrors.length === 0, 'no console errors');

    const assets = Object.entries(site.bytes)
      .filter(([f]) => /\.(js|wasm)$/.test(f))
      .map(([f, b]) => ({ file: f.replace(/-[A-Za-z0-9_-]{8}\./, '.'), kB: Math.round(b / 1024) }));
    const evidence = {
      lane: 'L-WALLET',
      plan: '00048',
      step: 'browser',
      at: new Date().toISOString(),
      chromium: browser.version(),
      harness: 'packages/wallet/test/browser (the wallet module bundled by Vite 8, no plugins)',
      totalSeconds,
      pass: failures.length === 0,
      failures,
      ...result,
      network: {
        hosts,
        httpRequests: sent.filter((s) => s.kind === 'http').length,
        wsFramesSent: sent.filter((s) => s.kind === 'ws' && s.body !== '').length,
        secretLeaks: leaks,
      },
      assetsLoaded: assets,
      consoleErrors: consoleErrors.slice(0, 20),
      failedRequests: failedRequests.slice(0, 20),
    };
    mkdirSync(OUT, { recursive: true });
    writeFileSync(path.join(OUT, 'browser.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    say(failures.length === 0 ? 'PASS' : 'FAIL', { totalSeconds, failures });
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    await browser.close();
    site.close();
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e: unknown) => {
    say('FAILED', { error: String((e as Error)?.message ?? e) });
    process.exit(1);
  },
);

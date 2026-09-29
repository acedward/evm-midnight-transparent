// The sponsor starts under Bun and serves: its config, a nonce, a refused unsigned open-swap, a
// refused bearer call, and a /health answer (503 while no proof server or sponsor wallet is there).
// No wallet is opened, no bridge is loaded (no key directory, no Sepolia RPC), and every probe
// /health makes points at a closed local port. The swaps are kept in a temporary directory. Used by
// CI and by scripts/docker-check.sh:
//
//   bun scripts/sponsor-smoke.ts        (port: SPONSOR_SMOKE_PORT, or a random one in 10000–59999)

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const port = Number(process.env.SPONSOR_SMOKE_PORT ?? 10_000 + Math.floor(Math.random() * 50_000));
const dir = mkdtempSync(join(tmpdir(), 'sponsor-smoke-'));
const tokens = join(dir, 'tokens.json');
writeFileSync(
  tokens,
  JSON.stringify({
    tokens: [
      { symbol: 'tA', midnightName: 'a', decimals: 6, midnightColour: 'aa'.repeat(32) },
      { symbol: 'tB', midnightName: 'b', decimals: 6, midnightColour: 'bb'.repeat(32) },
    ],
  }),
);
const closed = 'http://127.0.0.1:9';
const child = Bun.spawn(['bun', join(root, 'sponsor/src/main.ts')], {
  env: {
    ...process.env,
    SPONSOR_NETWORK: 'undeployed',
    TOKENS_FILE: tokens,
    SPONSOR_HOST: '127.0.0.1',
    SPONSOR_PORT: String(port),
    MIDNIGHT_PROOF_SERVER_URL: closed,
    ZSWAP_KERNEL_URL: closed,
    ZSWAP_BATCHER_URL: closed,
    SPONSOR_DATA_DIR: join(dir, 'data'),
    VAULT_MANAGED_DIR: join(dir, 'no-keys'),
  },
  stdout: 'pipe',
  stderr: 'pipe',
});

const base = `http://127.0.0.1:${port}`;
const fail = (msg: string): never => {
  throw new Error(`sponsor-smoke: ${msg}`);
};

try {
  let config: Response | null = null;
  for (let i = 0; i < 100 && !config?.ok; i++) {
    config = await fetch(`${base}/v1/config`).catch(() => null);
    if (!config?.ok) await Bun.sleep(100);
  }
  if (!config?.ok) fail('the sponsor did not serve /v1/config');
  const body = (await config!.json()) as { network?: string; chainId?: number };
  if (body.network !== 'undeployed' || body.chainId !== 11155111) fail(`unexpected config ${JSON.stringify(body)}`);
  const nonce = await fetch(`${base}/v1/auth/nonce`);
  if (!nonce.ok) fail(`/v1/auth/nonce answered ${nonce.status}`);
  const open = await fetch(`${base}/v1/swaps`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ swap: '11'.repeat(32), payload: {} }),
  });
  if (open.status < 400) fail(`an unsigned open-swap was accepted (${open.status})`);
  const bearer = await fetch(`${base}/v1/swaps/${'11'.repeat(32)}`, {
    headers: { authorization: `Bearer ${'x'.repeat(43)}` },
  });
  if (bearer.status !== 401) fail(`a wrong bearer token answered ${bearer.status}`);
  const health = await fetch(`${base}/v1/health`);
  if (health.status !== 503 && health.status !== 200) fail(`/v1/health answered ${health.status}`);
  console.log(
    `sponsor-smoke: PASS (port ${port}; unsigned open ${open.status}; bearer ${bearer.status}; health ${health.status})`,
  );
} finally {
  child.kill();
  await child.exited;
  rmSync(dir, { recursive: true, force: true });
}

// The vault key directory's checks, READ-ONLY (they query the Midnight indexer; they never prove,
// sign or send anything, and read no secret):
//
//   bun sponsor/src/tools/vault-keys.ts verify <dir>          every bridge circuit's verifier key (and the
//                                                            Signet singleton's signBidirectional) equal to
//                                                            the deployed one; writes <dir>/.vault-keys.json
//   bun sponsor/src/tools/vault-keys.ts rebuild-check <dir>  the sponsor's rebuild of a startWithdraw on the
//                                                            vault's live state is deterministic, and every
//                                                            argument changes its transcript digest
//
// <dir> is laid out as the vault's own `managed/` (Erc20Vault/ and SignetSigner/ side by side) and must
// sit under this repository's root (the generated module resolves compact-runtime from the root
// install). deploy/vault-keys/build.sh produces it and runs `verify`. Exit 0 = pass, 1 = fail.
//
// Environment: SPONSOR_NETWORK (default stagenet), MIDNIGHT_INDEXER_URL / MIDNIGHT_INDEXER_WS_URL,
// BRIDGE_VAULT_ADDRESS, BRIDGE_SIGNET_SINGLETON (overrides of the network profile).

import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  DEFAULT_EVM_GAS,
  resolveNetwork,
  stagenetRegistry,
  type NetworkOverrides,
} from '@evm-midnight-transparent/core';

import { rebuildStartWithdraw } from '../bridge/rebuild.js';
import { artefactFingerprints, loadVault, publicDataProviderFor, verifyVaultKeys } from '../bridge/vault.js';
import type { WithdrawCallArgs } from '../swaps/backend.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const env = (name: string) => {
  const v = process.env[name]?.trim();
  return v === undefined || v === '' ? undefined : v;
};
const say = (msg: string) => process.stderr.write(`vault-keys: ${msg}\n`);

function network() {
  const overrides: NetworkOverrides = {};
  const indexerUrl = env('MIDNIGHT_INDEXER_URL');
  const indexerWsUrl = env('MIDNIGHT_INDEXER_WS_URL');
  if (indexerUrl || indexerWsUrl)
    overrides.midnight = { ...(indexerUrl ? { indexerUrl } : {}), ...(indexerWsUrl ? { indexerWsUrl } : {}) };
  const vaultAddress = env('BRIDGE_VAULT_ADDRESS')?.replace(/^0x/, '').toLowerCase();
  const signetSingleton = env('BRIDGE_SIGNET_SINGLETON')?.replace(/^0x/, '').toLowerCase();
  if (vaultAddress || signetSingleton) {
    overrides.bridge = { ...(vaultAddress ? { vaultAddress } : {}), ...(signetSingleton ? { signetSingleton } : {}) };
  }
  return resolveNetwork(env('SPONSOR_NETWORK') ?? 'stagenet', overrides);
}

async function open(dir: string) {
  const n = network();
  const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
  setNetworkId(n.midnightNetworkId as never);
  const rt = await loadVault(dir);
  const pdp: Any = await publicDataProviderFor({
    networkId: n.midnightNetworkId,
    indexerUrl: n.midnight.indexerUrl,
    indexerWsUrl: n.midnight.indexerWsUrl,
    proofServerUrl: 'http://127.0.0.1:1',
  });
  return { n, rt, pdp };
}

async function verify(dir: string): Promise<boolean> {
  const { n, rt, pdp } = await open(dir);
  const keys = await verifyVaultKeys(rt, pdp, n.bridge.vaultAddress, n.bridge.signetSingleton);
  const report = {
    format: 'evm-midnight-transparent/vault-keys/1',
    checkedAt: new Date().toISOString(),
    network: n.name,
    vault: n.bridge.vaultAddress,
    singleton: n.bridge.signetSingleton,
    verified: keys.ok,
    circuits: keys.rows,
    artefacts: artefactFingerprints(rt.managedDir),
  };
  writeFileSync(join(dir, '.vault-keys.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  say(keys.ok ? `VERIFIED: ${keys.rows.length} verifier keys equal the chain's` : 'NOT VERIFIED: see the report');
  return keys.ok;
}

async function rebuildCheck(dir: string): Promise<boolean> {
  const { n, rt, pdp } = await open(dir);
  const vault = n.bridge.vaultAddress;
  // stkA as the vault bridges it (the circuit asserts the coin's colour is the vault's for the ERC20).
  const token = stagenetRegistry().bySymbol('stkA')!;
  const base: WithdrawCallArgs = {
    evmNonce: 9n,
    gas: DEFAULT_EVM_GAS,
    erc20: token.sepoliaAddress,
    amount: 1_000_000n,
    dest: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
    colour: token.midnightColour,
    coinNonce: '11'.repeat(32),
    refundCoinPk: '6ba8a1ae'.padEnd(64, '0'),
    tempCoinPk: '6ba8a1ae'.padEnd(64, '0'),
    tempEncPk: '22'.repeat(32),
  };
  const build = async (a: WithdrawCallArgs) => {
    const t0 = Date.now();
    const r = await rebuildStartWithdraw({ compiledContract: rt.compiledContract, ledger: rt.ledger }, pdp, vault, a);
    return { ...r, ms: Date.now() - t0 };
  };
  const a1 = await build(base);
  const a2 = await build(base);
  const variants: Record<string, Partial<WithdrawCallArgs>> = {
    amount: { amount: 2_000_000n },
    dest: { dest: '0x000000000000000000000000000000000000dEaD' },
    evmNonce: { evmNonce: 10n },
    coinNonce: { coinNonce: '33'.repeat(32) },
    refund: { refundCoinPk: '77'.repeat(32) },
    gas: { gas: { ...DEFAULT_EVM_GAS, gasLimit: 90_000n } },
  };
  const out: Record<string, unknown> = {
    block: a1.block,
    calls: a1.calls.map((c) => ({ address: c.address, entryPoint: c.entryPoint })),
    deterministic: a1.callsDigest === a2.callsDigest,
    sameRequestId: a1.requestId === a2.requestId,
    requestId: a1.requestId,
    buildMs: [a1.ms, a2.ms],
    variants: {} as Record<string, boolean>,
  };
  let ok = a1.callsDigest === a2.callsDigest && a1.requestId === a2.requestId;
  for (const [name, v] of Object.entries(variants)) {
    const b = await build({ ...base, ...v });
    (out.variants as Record<string, boolean>)[name] = b.callsDigest !== a1.callsDigest;
    ok &&= b.callsDigest !== a1.callsDigest;
  }
  out.pass = ok;
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  say(ok ? 'PASS: the rebuild is deterministic and sensitive to every argument' : 'FAIL: see the report');
  return ok;
}

const [cmd, dirArg] = process.argv.slice(2);
if (!cmd || !dirArg || !['verify', 'rebuild-check'].includes(cmd)) {
  say('usage: vault-keys.ts verify|rebuild-check <dir>');
  process.exit(64);
}
const dir = resolve(dirArg);
(cmd === 'verify' ? verify(dir) : rebuildCheck(dir)).then(
  (ok) => process.exit(ok ? 0 : 1),
  (e: unknown) => {
    say(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
/* eslint-enable @typescript-eslint/no-explicit-any */

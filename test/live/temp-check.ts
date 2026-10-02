// Plan 00048 P3: is a live swap's temporary wallet empty? Re-derive it the way the page does (the
// "start swap" message for the swap's salt, signed by the test EVM user), sync its shielded side from
// genesis, and print its balances and coins (public values only).
//
//   bun test/live/temp-check.ts <salt (0x + 64 hex)> [evidence-name] [derivation]
//
// The salt is the swap record's `salt` (P4.2-fix C14: the swap's public id is keccak256 of it; for the
// swaps of P3, recorded before the fix, the salt IS the id). `derivation` is the record's: 2 for
// swaps started after P4.2-fix (the default), 1 for the P3 swaps.
//
// The key file (`.sepolia`, SK=) is mounted read-only at LIVE_KEY_FILE and read in-process only;
// the seed never leaves this process. Run by test/live/run-live.sh temp-check.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  STAGENET,
  SWAP_KEY_DERIVATION_LATEST,
  deriveSwapSeed,
  publicSwapId,
  type StartSwapSigner,
} from '@evm-midnight-transparent/core';
import { createTempWallet } from '@evm-midnight-transparent/wallet';
import { Wallet } from 'ethers';

import { readSepoliaKey } from './sepolia-key.js';

const salt = (process.argv[2] ?? '').toLowerCase();
const name = process.argv[3] ?? 'temp-check';
const derivation = Number(process.argv[4] ?? SWAP_KEY_DERIVATION_LATEST);
if (!/^0x[0-9a-f]{64}$/.test(salt) || (derivation !== 1 && derivation !== 2))
  throw new Error('usage: temp-check.ts <salt> [evidence-name] [derivation 1|2]');
const KEY_FILE = process.env.LIVE_KEY_FILE ?? '/secrets/sepolia';
const OUT = process.env.LIVE_OUT_DIR ?? '';

const evm = new Wallet(readSepoliaKey(KEY_FILE));
const sign: StartSwapSigner = async (td) => {
  const { EIP712Domain: _domain, ...types } = td.types;
  return evm.signTypedData(td.domain, types, td.message);
};
const t0 = Date.now();
const out = await deriveSwapSeed(
  sign,
  { network: STAGENET.midnightNetworkId, vault: STAGENET.bridge.vaultAddress, salt, derivation: derivation as 1 | 2 },
  evm.address,
);
const wallet = await createTempWallet(out.seedHex);
try {
  const { ms } = await wallet.sync();
  const balances = Object.fromEntries(Object.entries(await wallet.balances()).map(([k, v]) => [k, v.toString()]));
  const coins = (await wallet.coins()).map((c) => ({ colour: c.colour, value: c.value.toString(), nonce: c.nonce }));
  const result = {
    plan: '00048 P3',
    check: 'the temporary wallet after the swap',
    swapId: derivation === 1 ? salt : `0x${publicSwapId(salt)}`,
    derivation,
    evmAddress: evm.address,
    deterministic: out.deterministic,
    coinPublicKey: wallet.coinPk,
    shieldedAddress: wallet.shieldedAddress,
    syncMs: ms,
    balances,
    coins,
    empty: coins.length === 0 && Object.values(balances).every((v) => v === '0'),
    totalMs: Date.now() - t0,
    writtenUtc: new Date().toISOString(),
  };
  console.log(JSON.stringify(result, null, 2));
  if (OUT) writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
} finally {
  await wallet.close();
}
process.exit(0);

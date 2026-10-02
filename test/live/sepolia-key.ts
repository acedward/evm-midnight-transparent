// The test EVM user's key from its secret file (`.sepolia`: an `SK=` or `PRIVATE_KEY=` line, maybe
// quoted or exported; or the bare key), as the gates read it (test/gates/take/gate.ts). In-process
// only: the key is returned to the caller and never printed, logged or written.

import { readFileSync } from 'node:fs';

export function readSepoliaKey(file: string): string {
  const text = readFileSync(file, 'utf8');
  let value = text.trim();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?(SK|PRIVATE_KEY)\s*=\s*(.*)$/.exec(line);
    if (m) value = (m[2] ?? '').trim().replace(/^['"]|['"]$/g, '');
  }
  const hex = value.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('the Sepolia secret file does not hold a 32-byte key');
  return `0x${hex}`;
}

// Where the sponsor keeps its swaps, so a restart loses nothing: a bridge round trip takes about
// 20 minutes and must be resumable from the vault request id the sponsor recorded.
//
// The store holds PUBLIC values only (./model.ts): swap ids, EVM addresses, public keys, deposit
// addresses, request ids, transaction hashes, stages. The bearer token is stored as its SHA-256;
// no seed or secret key ever reaches the sponsor. The JSON file is written atomically (a temporary
// file, fsync, rename) with mode 600 in a directory of mode 700, after every change.
//
// Retention: finished swaps (done, failed) are dropped `retainDays` after their last change. Swaps
// still in flight are never dropped: the temporary wallet may hold funds the user comes back for.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { isTerminal, type SwapRecord } from './model.js';

export interface SwapStore {
  get(swapId: string): SwapRecord | undefined;
  /** The swap whose temporary coin public key is `coinPk` (a deposit address serves one swap). */
  byCoinPk(coinPk: string): SwapRecord | undefined;
  all(): SwapRecord[];
  /** Insert or replace, and persist. */
  put(rec: SwapRecord): void;
  /** Remove one swap, and persist. */
  delete(swapId: string): void;
  /** Drop finished swaps older than the retention; returns how many. */
  prune(nowSeconds: number): number;
}

const FORMAT = 'evm-midnight-transparent-sponsor/swaps/1';

export class MemorySwapStore implements SwapStore {
  protected readonly swaps = new Map<string, SwapRecord>();

  constructor(protected readonly retainDays = 30) {}

  get(swapId: string) {
    return this.swaps.get(swapId);
  }

  byCoinPk(coinPk: string) {
    for (const r of this.swaps.values()) if (r.tempCoinPk === coinPk) return r;
    return undefined;
  }

  all() {
    return [...this.swaps.values()];
  }

  put(rec: SwapRecord) {
    this.swaps.set(rec.swapId, rec);
    this.persist();
  }

  delete(swapId: string) {
    if (this.swaps.delete(swapId)) this.persist();
  }

  prune(nowSeconds: number) {
    let n = 0;
    for (const [id, r] of this.swaps) {
      if (isTerminal(r.state) && nowSeconds - r.updatedAt > this.retainDays * 86_400) {
        this.swaps.delete(id);
        n++;
      }
    }
    if (n > 0) this.persist();
    return n;
  }

  protected persist(): void {}
}

export class StoreError extends Error {
  override name = 'StoreError';
}

/** The swaps in `<dir>/swaps.json`. */
export class JsonFileSwapStore extends MemorySwapStore {
  readonly file: string;

  constructor(
    readonly dir: string,
    retainDays = 30,
  ) {
    super(retainDays);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      /* a mounted volume may refuse; the file itself is 600 */
    }
    this.file = join(dir, 'swaps.json');
    if (existsSync(this.file)) {
      let parsed: { format?: unknown; swaps?: unknown };
      try {
        parsed = JSON.parse(readFileSync(this.file, 'utf8')) as typeof parsed;
      } catch {
        throw new StoreError(`${this.file} is not valid JSON: refusing to start over it (restore or move it)`);
      }
      if (parsed.format !== FORMAT || !Array.isArray(parsed.swaps)) {
        throw new StoreError(`${this.file} is not a ${FORMAT} file`);
      }
      for (const r of parsed.swaps as SwapRecord[]) this.swaps.set(r.swapId, r);
    }
  }

  protected override persist(): void {
    const body = `${JSON.stringify({ format: FORMAT, savedAt: new Date().toISOString(), swaps: this.all() })}\n`;
    const tmp = `${this.file}.tmp-${process.pid}`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }
}

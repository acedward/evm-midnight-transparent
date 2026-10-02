// Swap records in the browser store: one `swap` record per swap, filed under the connected wallet on
// the network, id = the PUBLIC swap id's 64 hex (never the salt, P4.2-fix C14). Every write is
// checked against the strict shape first (./record-shape.ts), so the page can only ever write what
// Import would accept, and nothing secret.

import type { LocalStore } from '../store/store.js';
import type { WalletScope } from '../store/schema.js';
import { type SwapRecord, SwapRecordSchema, isResumable } from './record-shape.js';

export class SwapRecordError extends Error {
  override name = 'SwapRecordError';
}

export const swapRecordId = (swapId: string) => swapId.replace(/^0x/, '').toLowerCase();

export function saveSwapRecord(store: LocalStore, record: SwapRecord): void {
  const parsed = SwapRecordSchema.safeParse(record);
  if (!parsed.success)
    throw new SwapRecordError(`a swap record is not in its shape: ${parsed.error.issues[0]?.message ?? ''}`);
  store.put({ network: record.network, evmAddress: record.evmAddress }, 'swap', parsed.data, {
    id: swapRecordId(record.swapId),
  });
}

/** The wallet's swap records on the network, newest first; unreadable ones are skipped. */
export function readSwapRecords(store: LocalStore, scope: WalletScope): SwapRecord[] {
  const out: SwapRecord[] = [];
  for (const v of store.list(scope)) {
    if (v.parsed.kind !== 'swap' || !v.record) continue;
    const r = SwapRecordSchema.safeParse(v.record.data);
    if (r.success) out.push(r.data);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function readSwapRecord(store: LocalStore, scope: WalletScope, swapId: string): SwapRecord | null {
  return readSwapRecords(store, scope).find((r) => r.swapId === swapId.toLowerCase()) ?? null;
}

/** Records the page offers "Resume" for: not finished, or failed and recoverable (P4.2-fix C5). */
export const inProgress = (records: readonly SwapRecord[]) => records.filter((r) => isResumable(r));

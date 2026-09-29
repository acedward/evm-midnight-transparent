// The browser store's layout. Every per-user record this app keeps lives in this browser's
// localStorage, under one prefix, namespaced by Midnight network and EVM address:
//
//   evm-midnight-transparent/schema                                   the schema version (an integer)
//   evm-midnight-transparent/v1/_global/<kind>[/<id>]                 settings for this browser
//   evm-midnight-transparent/v1/<network>/<0xevm lowercase>/<kind>[/<id>]   a wallet's records
//
// Each value is JSON: {"v": 1, "kind", "updatedAt" (ms), "data"}.
//
// No record ever holds a secret: each swap's temporary Midnight wallet key lives in the tab's memory
// only, and is re-derived by signing the swap's message again (spec FR-003, Q4).
//
// Copied from MN Bank (acedward/passport-evm-dapp @ 911647b, web/src/store/schema.ts) without its
// account level and its secret records. TODO(L-WEB): the `swap` record kind (no secrets), with its
// strict shape in ./record-schemas.ts.

import { z } from 'zod';

export const STORE_PREFIX = 'evm-midnight-transparent/';
export const SCHEMA_KEY = 'evm-midnight-transparent/schema';
export const SCHEMA_VERSION = 1;
const V1 = 'evm-midnight-transparent/v1/';

export const RECORD_KINDS = ['profile', 'settings'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export interface WalletScope {
  network: string;
  /** 0x-prefixed, lowercase. */
  evmAddress: string;
}

export type RecordScope = { global: true } | { global: false; network: string; evmAddress: string };

const NETWORK_RE = /^[a-z0-9-]{1,32}$/;
const EVM_RE = /^0x[0-9a-f]{40}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export class StoreKeyError extends Error {
  override name = 'StoreKeyError';
}

export function normaliseScope(scope: WalletScope): WalletScope {
  const s = { network: scope.network, evmAddress: scope.evmAddress.toLowerCase() };
  if (!NETWORK_RE.test(s.network)) throw new StoreKeyError(`bad network "${scope.network}"`);
  if (!EVM_RE.test(s.evmAddress)) throw new StoreKeyError('bad EVM address');
  return s;
}

/** The localStorage key of a record. */
export function recordKey(scope: WalletScope | 'global', kind: RecordKind, opts: { id?: string } = {}): string {
  const id = opts.id;
  if (id !== undefined && !ID_RE.test(id)) throw new StoreKeyError(`bad record id "${id}"`);
  const tail = id === undefined ? kind : `${kind}/${id}`;
  if (scope === 'global') return `${V1}_global/${tail}`;
  const s = normaliseScope(scope);
  return `${V1}${s.network}/${s.evmAddress}/${tail}`;
}

export interface ParsedKey {
  scope: RecordScope;
  kind: RecordKind;
  id?: string;
}

/** Parse a v1 record key; null for anything that is not one. */
export function parseKey(key: string): ParsedKey | null {
  if (!key.startsWith(V1)) return null;
  const parts = key.slice(V1.length).split('/');
  const isKind = (k: string | undefined): k is RecordKind => (RECORD_KINDS as readonly string[]).includes(k ?? '');
  if (parts[0] === '_global') {
    const [, kind, id, ...rest] = parts;
    if (!isKind(kind) || rest.length > 0 || (id !== undefined && !ID_RE.test(id))) return null;
    return { scope: { global: true }, kind, ...(id !== undefined ? { id } : {}) };
  }
  const [network, evm, kind, id, ...rest] = parts;
  if (!network || !NETWORK_RE.test(network) || !evm || !EVM_RE.test(evm)) return null;
  if (!isKind(kind) || rest.length > 0 || (id !== undefined && !ID_RE.test(id))) return null;
  return {
    scope: { global: false, network, evmAddress: evm },
    kind,
    ...(id !== undefined ? { id } : {}),
  };
}

export function inWalletScope(parsed: ParsedKey, scope: WalletScope): boolean {
  const s = normaliseScope(scope);
  return !parsed.scope.global && parsed.scope.network === s.network && parsed.scope.evmAddress === s.evmAddress;
}

export const StoredRecordSchema = z.object({
  v: z.literal(1),
  kind: z.enum(RECORD_KINDS),
  updatedAt: z.number().int().nonnegative(),
  data: z.unknown(),
});
export type StoredRecord<T = unknown> = { v: 1; kind: RecordKind; updatedAt: number; data: T };

export function encodeRecord<T>(kind: RecordKind, data: T, updatedAt: number): string {
  return JSON.stringify({ v: 1, kind, updatedAt, data });
}

// ── Export files ────────────────────────────────────────────────────────────

export const EXPORT_FORMAT = 'evm-midnight-transparent-local-data';
export const EXPORT_FORMAT_VERSION = 1;

/** The most an import's records may hold: their total size once serialised, key + value in UTF-16
 *  code units, the measure localStorage itself uses, and about what it holds per site (5 MiB). So
 *  every export of this page's own records fits. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
/** The largest file Import reads at all, before parsing it (a guard against absurd files, not the
 *  export's limit). An export is compact JSON (`exportFileText`): its records plus a few bytes each,
 *  and at most 3 UTF-8 bytes per character, so every export whose records fit
 *  `MAX_IMPORT_FILE_BYTES` is smaller than this. */
export const MAX_IMPORT_READ_BYTES = 4 * MAX_IMPORT_FILE_BYTES;
export const MAX_IMPORT_RECORDS = 10_000;

export const ExportFileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.literal(EXPORT_FORMAT_VERSION),
  schemaVersion: z.number().int().positive(),
  exportedAt: z.string(),
  network: z.string().regex(NETWORK_RE),
  evmAddress: z.string().regex(EVM_RE),
  records: z
    .array(z.object({ key: z.string().startsWith(STORE_PREFIX).max(512), value: z.unknown() }))
    .max(MAX_IMPORT_RECORDS),
});
export type ExportFile = z.infer<typeof ExportFileSchema>;

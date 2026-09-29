// The shape of every record kind this page writes, so an Import accepts only records this page
// could have written itself: every field known and well-typed, nothing else, and each record
// consistent with the key it is filed under. A change to what the page writes must be made here
// too, and the store tests import a record of every kind written the way the page writes it.
//
// Copied from MN Bank (acedward/passport-evm-dapp @ 911647b, web/src/store/record-schemas.ts)
// without its account, secret, coin, transfer and offer records. TODO(L-WEB): the `swap` record.

import { z } from 'zod';

import type { ParsedKey, RecordKind } from './schema.js';

const ms = z.number().int().nonnegative();
const text = (max: number) => z.string().max(max);

const profile = z.object({ firstSeen: ms.optional(), lastSeen: ms.optional() }).strict();

/** A small flat map of display settings. */
const settings = z.record(z.string().max(64), z.union([text(256), z.number(), z.boolean(), z.null()]));

export const RECORD_DATA_SCHEMAS: Record<RecordKind, z.ZodType> = { profile, settings };

/**
 * Why an imported record's data is not one this page writes, or null when it is. Checks its shape
 * for its kind, and that it agrees with the key it is filed under.
 */
export function recordDataProblem(key: ParsedKey, data: unknown): string | null {
  const r = RECORD_DATA_SCHEMAS[key.kind].safeParse(data);
  if (!r.success) return `a ${key.kind} record is not in the shape this page writes`;
  if (key.kind === 'profile' && (key.scope.global || key.id !== undefined))
    return 'a profile record belongs to one wallet, with no id';
  return null;
}

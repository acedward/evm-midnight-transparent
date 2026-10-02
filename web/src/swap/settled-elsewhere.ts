// Vault requests of a swap that ANOTHER party settled (plan 00048 P4.2-fix4, lane FS4; the audit's
// T1 / F-A41). The vault's settles are permissionless, and whoever submits one chooses the minted
// coin's nonce and the key its ciphertext is sealed to. The nonce is never public (questions file Q16),
// so a coin minted by someone else's settle is owned by the temporary wallet's key but can never be
// found or spent by it: that amount is lost for the user (nobody else can spend it either).
//
// The sponsor reports these as `settledElsewhere` and moves the swap on with what is left (a `partial`
// deposit with Bridge back, or `failed` / `settled-elsewhere` when nothing is left). The page only
// keeps the lost parts on the record and says so. This file is the ONE place the page reads them.

import type { SwapRecord } from './record-shape.js';
import type { SwapView } from './sponsor-client.js';

/** The `failed` reason of a swap whose funds were all lost that way. */
export const SETTLED_ELSEWHERE_REASON = 'settled-elsewhere';

export type LostPart = NonNullable<SwapRecord['lost']>[number];

/** The lost parts of a view (each a positive amount of a known colour), oldest first, at most 8. */
export function lostParts(view: Pick<SwapView, 'settledElsewhere'>): LostPart[] {
  const out: LostPart[] = [];
  for (const e of view.settledElsewhere ?? []) {
    if (!e.lost || BigInt(e.amount) <= 0n) continue;
    out.push({
      kind: e.kind,
      colour: e.colour,
      amount: e.amount,
      ...(e.requestId ? { requestId: e.requestId } : {}),
      ...(e.evmTx ? { evmTx: e.evmTx } : {}),
    });
  }
  return out.slice(-8);
}

/** The record's lost parts after a view: the sponsor's report when it sends one, else the record's. */
export function lostRecord(
  record: Pick<SwapRecord, 'lost'>,
  view: Pick<SwapView, 'settledElsewhere'>,
): SwapRecord['lost'] | undefined {
  if (view.settledElsewhere === undefined) return record.lost;
  const parts = lostParts(view);
  return parts.length > 0 ? parts : undefined;
}

/** The leg of the record a lost part is in (its colour), for its symbol and decimals. */
export function lostLeg(record: Pick<SwapRecord, 'offer'>, part: LostPart) {
  return [record.offer.pay, record.offer.receive].find((l) => l.colour === part.colour) ?? null;
}

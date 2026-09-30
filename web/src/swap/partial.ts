// A PARTIAL deposit (plan 00048 P4.2-fix3, lane FW3; the audit's S2, F-A32 and F-B33): a completed
// vault request minted LESS than the pay amount to the swap's temporary wallet. `startDeposit` is
// permissionless, so anyone can post a 1-unit request for this swap's recipient and win the sweep
// race; or a sweep landed between two of the sponsor's polls. Then part of the user's tokens is in
// the temporary wallet and the rest is still at the deposit address.
//
// The sponsor reports it as the state `partial` with `partial = {minted, remaining, atAddress,
// options}` (FS3's wire, plan "Lane contracts", P4.2-fix3 lane FS3 items 1–8):
//
//   wait         the sponsor deposits the REST by itself (no call) once the deposit address holds it
//                and the sweep ETH; the page tops up only the sweep ETH when the address lacks it (the
//                other request's sweep usually spent it) and shows the progress. It never sends the
//                token again. When the whole pay amount is in the temporary wallet, the swap goes on.
//   bridge-back  the existing Bridge back path (withdraw-params → buildWithdraw → /prove → /withdraw)
//                for `minted`, what the temporary wallet received. Afterwards what waits at the
//                deposit address is deposited by the sponsor and shows as `minted` again, for a second
//                Bridge back, until nothing is left to recover.
//
// This file is the ONE place the page reads that report, so only this file changes with the wire.

import type { SwapRecord } from './record-shape.js';
import type { SwapView } from './sponsor-client.js';

export interface PartialDeposit {
  /** Pay-token base units the temporary wallet holds from completed deposits (a Bridge back from
   *  `partial` already returned the rest of what was minted). */
  minted: bigint;
  /** Base units still to be deposited for the temporary wallet to have held the whole pay amount. */
  remaining: bigint;
  /** The pay token the sponsor last read at the deposit address (informative), or null. */
  atAddress: bigint | null;
  /** "Wait for the rest" is on offer: the sponsor deposits `remaining` once it is at the address. */
  canWait: boolean;
  /** "Bridge back" is on offer: the temporary wallet returns `minted`. */
  canBridgeBack: boolean;
  /** When the sponsor starts the rest's deposit, if it paces it (deposit stage `rearm-wait`): ms. */
  retryAt: number | null;
}

const toMs = (at: number) => (at < 1e12 ? Math.round(at * 1000) : Math.round(at));

/** The sponsor's partial-deposit report, checked against the swap's pay amount; null when the swap
 *  is not `partial` (every sponsor before FS3 never says it) or the report is not one the page can
 *  act on. */
export function partialOf(
  view: Pick<SwapView, 'state' | 'partial' | 'deposit'>,
  payAmount: bigint,
): PartialDeposit | null {
  const p = view.partial;
  if (view.state !== 'partial' || !p) return null;
  const minted = BigInt(p.minted);
  const remaining = BigInt(p.remaining);
  // Never more than the swap pays, and something to do: a report outside that is not acted on.
  if (minted + remaining > payAmount || minted + remaining === 0n) return null;
  const last = view.deposit?.stages?.at(-1);
  const retryAt =
    last?.stage === 'rearm-wait' && /^\d{1,13}$/.test(String(last.detail?.retryAt ?? ''))
      ? toMs(Number(last.detail!.retryAt))
      : null;
  return {
    minted,
    remaining,
    atAddress: p.atAddress !== undefined ? BigInt(p.atAddress) : null,
    canWait: p.options.includes('wait') && remaining > 0n,
    canBridgeBack: p.options.includes('bridge-back') && minted > 0n,
    retryAt,
  };
}

/** The record's partial block from a view's report (the user's "wait" choice kept), or undefined. */
export function partialRecord(
  record: Pick<SwapRecord, 'partial' | 'offer'>,
  view: Pick<SwapView, 'state' | 'partial' | 'deposit'>,
): SwapRecord['partial'] | undefined {
  const p = partialOf(view, BigInt(record.offer.pay.amount));
  if (!p) return undefined;
  return {
    minted: p.minted.toString(),
    remaining: p.remaining.toString(),
    ...(record.partial?.wait ? { wait: true } : {}),
  };
}

/** How much of the pay token a Bridge back returns now: on a partial deposit what the temporary
 *  wallet received (S2), else the whole pay amount ("Swap is not available", Q6). */
export function bridgeBackAmount(record: Pick<SwapRecord, 'partial' | 'offer'>): bigint {
  return record.partial ? BigInt(record.partial.minted) : BigInt(record.offer.pay.amount);
}

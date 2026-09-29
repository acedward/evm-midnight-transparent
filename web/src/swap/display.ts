// Small text helpers for the swap pages. Amounts are exact (bigint base units, never floats).

import { formatUnits } from '@evm-midnight-transparent/core';

/** "1,040.50": at least two decimals, all the token's significant ones. */
export const amountText = (raw: bigint | string, decimals: number) =>
  formatUnits(BigInt(raw), decimals, { minFractionDigits: 2, grouping: true });

/** "1.04 USDC" for a record leg (the Sepolia symbol: the user pays and receives on Sepolia). */
export const legText = (l: { amount: string | bigint; decimals: number; symbol: string }) =>
  `${amountText(l.amount, l.decimals)} ${l.symbol}`;

/** Sepolia ETH, at most seven decimals (truncated, never rounded up). */
export const ethText = (wei: bigint | string) =>
  `${formatUnits(BigInt(wei), 18, { minFractionDigits: 4, maxFractionDigits: 7 })} ETH`;

/** "14:06:09 UTC". */
export const clockText = (ms: number) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

/** "2026-09-29 14:06 UTC". */
export const dateText = (ms: number) => `${new Date(ms).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

/** "3 min 05 s", "45 s". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

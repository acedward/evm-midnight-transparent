// Small presentation helpers shared by the design components and the pages.

import type { TokenEntry } from '@evm-midnight-transparent/core';

/** Join class names, skipping empty ones. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** "0x4847…e56b": a long hex value shortened for display (the full value belongs in `title`). */
export function shortHex(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * A plain-language name for a token, shown after its symbol ("TB13W  Test T-Bill 13-week"), or ''
 * when the name adds nothing (it is the symbol itself). Presentation only: the registry's symbol
 * and Midnight name stay the identifiers. No token is special.
 */
export function tokenDisplayName(token: Pick<TokenEntry, 'name' | 'symbol'>): string {
  return token.name === token.symbol ? '' : token.name;
}

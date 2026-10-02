// The mock ports' "transactions": tagged JSON in hex, so the mock sponsor can check what the mock
// wallet built (the real sponsor's validation rules, in miniature) and the mock batcher can apply it.

import { hexlify, toUtf8Bytes, toUtf8String } from 'ethers';

export interface MockTx {
  mock: 'emt-tx';
  kind: 'take' | 'withdraw';
  coinPk: string;
  offerId?: string;
  colour?: string;
  amount?: string;
  dest?: string;
  coinNonce?: string;
  evmNonce?: string;
  /** The draft this transaction was built as (the real module checks identifiers the same way). */
  draft?: string;
  /** The coins it pays back to the temporary wallet (a take's received coin; P4.2-fix2 R1). */
  outputs?: Array<{ nonce: string; colour: string; value: string }>;
  proven?: true;
  /** A take merged into the maker's transaction (`finalizeTake`). */
  merged?: true;
  /** A withdrawal bound after proving (`finalizeWithdraw`). */
  bound?: true;
}

export const encodeMockTx = (tx: Omit<MockTx, 'mock'>): string =>
  hexlify(toUtf8Bytes(JSON.stringify({ mock: 'emt-tx', ...tx }))).slice(2);

export function decodeMockTx(hex: string): MockTx | null {
  try {
    const v = JSON.parse(toUtf8String(`0x${hex.replace(/^0x/, '')}`)) as MockTx;
    return v && v.mock === 'emt-tx' ? v : null;
  } catch {
    return null;
  }
}

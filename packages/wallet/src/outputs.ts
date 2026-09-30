// The coins a transaction pays to the temporary wallet, as `/prove` discloses them (P4.2-fix2 R1;
// plan "Lane contracts", FS2 item 1 and FW2 item 4).
//
// The sponsor proves only what it can account for: every guaranteed output of a take or a
// withdrawal must be the vault's own coin (a withdrawal) or a coin paid back to this swap's
// temporary wallet. A commitment hides its coin, so the wallet discloses each of its own outputs:
// the nonce, the colour and the value. The sponsor recomputes `coinCommitment(coin, tempCoinPk)` and
// refuses any output that is neither (`undisclosed-output`). Nothing here is secret: a coin's nonce,
// colour and value, without the wallet's keys, spend nothing, and the sponsor already knows the
// swap's colours and amounts.
//
// FS2's recipe, checked on the real ledger: apply the transaction's guaranteed offer to an EMPTY
// local state with the wallet's keys; the coins it gains are exactly the outputs sealed to the wallet
// (a take's received coin and its change; a withdrawal's change, none when the coin was exact).

import * as ledger from '@midnightntwrk/ledger-v9';

import type { WalletOutput } from './sponsor-client.js';
import { internalsOf, type TempWallet } from './temp-wallet.js';
import { type AnyTransaction, unprovenFromHex } from './tx.js';

export type { WalletOutput };

const norm = (h: unknown) => String(h).replace(/^0x/i, '').toLowerCase();

/** The outputs of `tx`'s guaranteed offer that the holder of `secretKeys` receives. */
export function walletOutputsFromKeys(secretKeys: ledger.ZswapSecretKeys, tx: AnyTransaction): WalletOutput[] {
  const offer = tx.guaranteedOffer;
  if (offer === undefined) return [];
  const state = new ledger.ZswapLocalState().apply(secretKeys, offer);
  return [...state.coins]
    .map((c) => ({ nonce: norm(c.nonce), colour: norm(c.type), value: c.value }))
    .sort((a, b) => (a.colour + a.nonce < b.colour + b.nonce ? -1 : 1));
}

/** The outputs of `tx` (a transaction or its unproven hex) that the temporary wallet receives. */
export function walletOutputsOf(wallet: TempWallet, tx: AnyTransaction | string): WalletOutput[] {
  const { keys } = internalsOf(wallet);
  return walletOutputsFromKeys(keys.shieldedSecretKeys, typeof tx === 'string' ? unprovenFromHex(tx) : tx);
}

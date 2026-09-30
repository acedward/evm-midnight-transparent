// Transactions on the wire between the browser and the sponsor, and the checks the wallet makes on
// every transaction it builds or gets back (plan, "Lane contracts": `/prove` and `/withdraw`).
//
// The wire form is the ledger-v9 serialisation as lowercase hex without 0x:
//   - what the wallet sends to `/prove` is UNPROVEN: `Transaction<SignatureEnabled, PreProof, PreBinding>`;
//   - what `/prove` returns is PROVEN and normally still PRE-BINDING
//     (`Transaction<SignatureEnabled, Proof, PreBinding>`); the wallet binds it here (G-BRIDGE bound the
//     proven `startWithdraw` itself). A transaction that comes back already bound is accepted as is.
// Nothing here is secret: a proven transaction carries proofs, not keys.

import * as ledger from '@midnightntwrk/ledger-v9';

import { bytesToHex, hexToBytes } from '@evm-midnight-transparent/core';

export type AnyTransaction = ledger.Transaction<ledger.Signaturish, ledger.Proofish, ledger.Bindingish>;
export type UnprovenTx = ledger.UnprovenTransaction;
export type ProvenUnboundTx = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.PreBinding>;
export type FinalizedTx = ledger.Transaction<ledger.SignatureEnabled, ledger.Proof, ledger.Binding>;

export class TxFormatError extends Error {
  override name = 'TxFormatError';
}

/** A transaction's bytes as the wire carries them: lowercase hex, no 0x. */
export function txToHex(tx: { serialize(): Uint8Array }): string {
  return bytesToHex(tx.serialize());
}

function bytesOf(hex: string): Uint8Array {
  try {
    return hexToBytes(hex.trim());
  } catch {
    throw new TxFormatError('the transaction is not hex');
  }
}

/** An unproven transaction from the wire (what `/prove` receives). */
export function unprovenFromHex(hex: string): UnprovenTx {
  try {
    return ledger.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', bytesOf(hex));
  } catch (e) {
    if (e instanceof TxFormatError) throw e;
    throw new TxFormatError('the transaction is not an unproven ledger transaction');
  }
}

/** A proven, pre-binding transaction from the wire (what `/prove` normally returns). */
export function provenUnboundFromHex(hex: string): ProvenUnboundTx {
  try {
    return ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', bytesOf(hex));
  } catch (e) {
    if (e instanceof TxFormatError) throw e;
    throw new TxFormatError('the transaction is not a proven, pre-binding ledger transaction');
  }
}

/**
 * A proven transaction from the wire, bound: a pre-binding transaction is bound here; one that is
 * already bound is returned as is. Anything else (unproven, proof-erased) is refused.
 */
export function provenFromHex(hex: string): { tx: FinalizedTx; wasBound: boolean } {
  const bytes = bytesOf(hex);
  let unbound: ProvenUnboundTx | undefined;
  try {
    unbound = ledger.Transaction.deserialize('signature', 'proof', 'pre-binding', bytes);
  } catch {
    unbound = undefined;
  }
  if (unbound !== undefined) return { tx: unbound.bind(), wasBound: false };
  try {
    return { tx: ledger.Transaction.deserialize('signature', 'proof', 'binding', bytes), wasBound: true };
  } catch {
    throw new TxFormatError('the transaction is not a proven ledger transaction');
  }
}

/** The transaction with its proofs (and binding) erased, hex: what proving must not change. Every
 *  Zswap input (nullifier, value commitment), output (coin commitment, value commitment, ciphertext
 *  to the recipient) and transient, every intent, contract call and transcript is in it; only the
 *  proofs, their preimages and the binding randomness are not. */
export function erasedHex(tx: AnyTransaction): string {
  return bytesToHex(tx.eraseProofs().serialize());
}

/**
 * A proven transaction handed back for a draft (the sponsor's `/prove` answer) must BE the draft:
 * every identifier of the draft is there, and once proofs are erased the two are byte-identical.
 * Identifiers alone are the outputs' value commitments, which bind neither recipients nor call
 * arguments, and allow additions (the audit's F-A9 / F-B9, P4.2-fix C10).
 */
export function assertSameAsDraft(
  draft: { readonly identifiers: readonly string[]; readonly erased: string },
  proven: AnyTransaction,
): void {
  const ids = new Set(proven.identifiers().map(String));
  const missing = draft.identifiers.filter((id) => !ids.has(id));
  if (missing.length > 0) throw new Error(`it lacks ${missing.length} of the draft's identifiers`);
  if (erasedHex(proven) !== draft.erased)
    throw new Error('it is not the transaction that was built: its inputs, outputs or calls differ from the draft');
}

/** Every shielded colour's imbalance in segment 0 (fees aside): zero for a balanced settlement. */
export function shieldedImbalances(tx: AnyTransaction): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const [type, value] of tx.imbalances(0)) {
    if (type.tag === 'shielded') out[type.raw.replace(/^0x/, '').toLowerCase()] = value;
  }
  return out;
}

/** The colours whose segment-0 shielded imbalance is not zero. */
export function unbalancedColours(tx: AnyTransaction): string[] {
  return Object.entries(shieldedImbalances(tx))
    .filter(([, v]) => v !== 0n)
    .map(([c]) => c);
}

/** How many DUST spends the transaction carries (the temporary wallet never has DUST: always 0). */
export function dustSpendCount(tx: AnyTransaction): number {
  let n = 0;
  for (const intent of tx.intents?.values() ?? []) n += intent.dustActions?.spends.length ?? 0;
  return n;
}

/** Whether the transaction moves unshielded tokens (the temporary wallet has none). */
export function hasUnshieldedOffers(tx: AnyTransaction): boolean {
  for (const intent of tx.intents?.values() ?? []) {
    if (intent.guaranteedUnshieldedOffer !== undefined || intent.fallibleUnshieldedOffer !== undefined) return true;
  }
  return false;
}

export interface ContractCallView {
  /** The contract's address, 64 lowercase hex. */
  address: string;
  entryPoint: string;
}

/** The contract calls in the transaction, in order (root calls and cross-contract callees alike). */
export function contractCalls(tx: AnyTransaction): ContractCallView[] {
  const out: ContractCallView[] = [];
  for (const intent of tx.intents?.values() ?? []) {
    for (const action of intent.actions) {
      if (!(action instanceof ledger.ContractCall)) continue;
      const ep = action.entryPoint as unknown;
      out.push({
        address: String(action.address).replace(/^0x/, '').toLowerCase(),
        entryPoint: typeof ep === 'string' ? ep : new TextDecoder().decode(ep as Uint8Array),
      });
    }
  }
  return out;
}

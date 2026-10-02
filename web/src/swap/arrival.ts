// Done on arrival (plan 00048 P4.2-fix4, lane FW4; the owner's live swap: "Stuck on done, but I have
// the tokens in my EVM wallet"). The bridge's withdrawal pays the user on Sepolia about a minute after
// it starts; the sponsor then waits about 17 minutes for the MPC network's attestation and closes the
// request on Midnight (`completeWithdraw`) before it says `done`. Nothing in that closing involves the
// user, so the page shows Done as soon as the tokens are at the user's address, and keeps following
// the bridge in the background.
//
// The page never takes the sponsor's word for the arrival: the sponsor only names the Sepolia hash
// (`withdraw.sepoliaTx`, once the relay saw it mined). The page reads that transaction's receipt
// through the user's own wallet and counts it only when ALL of these hold:
//
//   - it is mined with status 1;
//   - it carries an ERC20 `Transfer(from, to, value)` log emitted by the Sepolia contract of the token
//     the swap pays out (the receive leg; after Bridge back, the pay leg), as the page's own token
//     registry names it, from the vault's EVM account (the network profile's `vaultEvmAddress`, the
//     account the vault's `startWithdraw` transfers from) to the swap's own EVM address;
//   - it was mined AFTER the user's own funding transfer of this swap (so an older transfer, such as
//     another swap's, is never counted for this one), and it is not counted for another swap here;
//   - its TRANSACTION (`eth_getTransactionByHash`) is from the vault's EVM account with a nonce that
//     one of THIS swap's own withdrawals signed (P4.2-fix5 U4, the audit's F-B53): the page supplied
//     that nonce to `/prove` (`evmNonce`, a public argument of the vault's `startWithdraw`, which the
//     MPC-signed transfer carries) and the record keeps it (`bridgeOut.evmNonces`). Every withdrawal of
//     the vault shares its one account, so a nonce names one mined transfer: another swap's payout of
//     the same token and amount to the same user (the sponsor naming the wrong hash) is never counted.
//     A record written before kept no nonce: its payout is never counted (the sponsor's `done` ends it).
//
// What arrived is the log's value. The swap is done for the user when the verified arrivals add up to
// EXACTLY the whole amount it pays out (record-shape.ts `arrivedInFull`): a failed transfer, another
// token, another amount, or the first part of a partial Bridge back is never Done.

import { getAddress } from 'ethers';

import type { NetworkProfile, TokenRegistry } from '@evm-midnight-transparent/core';

import type { MinedReceipt, MinedTransaction } from './evm.js';
import { type SwapRecord, outLeg } from './record-shape.js';
import type { SwapView } from './sponsor-client.js';

/** keccak256("Transfer(address,address,uint256)"): the ERC20 `Transfer` event's topic. */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** How long the bridge takes to close a request after the transfer (the attestation, then
 *  `completeWithdraw`): the owner's live swap took about 18 minutes; MN Bank measured 14–20. */
export const BRIDGE_CLOSE_ESTIMATE_MIN = 17;

/** The transfer the page expects at the user's address. */
export interface ExpectedArrival {
  /** The ERC20's Sepolia address (lowercase), from the page's registry. */
  token: string;
  /** The vault's EVM account (lowercase): the withdrawal transfers from it. */
  from: string;
  /** The swap's EVM address (lowercase). */
  to: string;
  /** The paid-out leg's colour on Midnight, and its whole amount. */
  colour: string;
  total: bigint;
}

/** What the page expects for this swap's payout, or null when it cannot tell (no vault EVM account
 *  configured, a token without a Sepolia address): then only the sponsor's `done` ends the swap. */
export function expectedArrival(
  record: Pick<SwapRecord, 'choice' | 'offer' | 'evmAddress'>,
  network: Pick<NetworkProfile, 'bridge'>,
  registry: Pick<TokenRegistry, 'byColour'>,
): ExpectedArrival | null {
  const leg = outLeg(record);
  const token = registry.byColour(leg.colour)?.sepoliaAddress;
  const vault = network.bridge.vaultEvmAddress;
  if (!token || !vault) return null;
  try {
    return {
      token: getAddress(token).toLowerCase(),
      from: getAddress(vault).toLowerCase(),
      to: getAddress(record.evmAddress).toLowerCase(),
      colour: leg.colour,
      total: BigInt(leg.amount),
    };
  } catch {
    return null;
  }
}

const topicOf = (address: string) => `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;

export type TransferCheck =
  /** The expected transfer is in the receipt: `amount` base units reached the user. */
  | { kind: 'arrived'; amount: bigint }
  /** Mined, and reverted: nothing moved. */
  | { kind: 'reverted' }
  /** Mined, with no `Transfer` of the expected token from the vault to the user (another token,
   *  sender or recipient, or no transfer at all). */
  | { kind: 'no-transfer' }
  /** Mined before the user funded this swap: not this swap's transfer. */
  | { kind: 'too-early' };

/**
 * What a mined receipt says about the expected transfer. `fundedAt` is the block of the user's own
 * funding transfer of this swap: the payout must be mined after it (null: unknown, never arrived).
 * Several matching logs in one transaction add up (the user received all of them).
 */
export function checkTransfer(
  receipt: MinedReceipt,
  expected: Pick<ExpectedArrival, 'token' | 'from' | 'to'>,
  fundedAt: number | null,
): TransferCheck {
  if (receipt.status !== 'success') return { kind: 'reverted' };
  const from = topicOf(expected.from);
  const to = topicOf(expected.to);
  let amount = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== expected.token.toLowerCase()) continue;
    if (log.topics.length !== 3 || log.topics[0] !== ERC20_TRANSFER_TOPIC) continue;
    if (log.topics[1] !== from || log.topics[2] !== to) continue;
    if (!/^0x[0-9a-f]{64}$/.test(log.data)) continue;
    amount += BigInt(log.data);
  }
  if (amount === 0n) return { kind: 'no-transfer' };
  if (fundedAt === null || receipt.blockNumber <= fundedAt) return { kind: 'too-early' };
  return { kind: 'arrived', amount };
}

/** Whether a payout's transaction is one of this swap's own withdrawals (P4.2-fix5 U4): from the vault's
 *  EVM account, with a nonce one of them signed (the record's `bridgeOut.evmNonces`; none: never). */
export function boundToWithdrawal(
  tx: Pick<MinedTransaction, 'from' | 'nonce'>,
  expected: Pick<ExpectedArrival, 'from'>,
  nonces: readonly string[] | undefined,
): boolean {
  if (tx.from.toLowerCase() !== expected.from.toLowerCase()) return false;
  return (nonces ?? []).some((n) => /^\d{1,20}$/.test(n) && BigInt(n) === tx.nonce);
}

/** The Sepolia hashes the sponsor reported for this swap's withdrawals (every attempt), and the ones
 *  the record kept, that the page has not verified yet. */
export function arrivalCandidates(record: SwapRecord, view: SwapView | null): string[] {
  const seen = new Set((record.arrivals ?? []).map((a) => a.tx));
  const out: string[] = [];
  const add = (h: string | undefined) => {
    const v = h?.toLowerCase();
    if (v && /^0x[0-9a-f]{64}$/.test(v) && !seen.has(v) && !out.includes(v)) out.push(v);
  };
  for (const w of view?.withdrawals ?? []) add(w.sepoliaTx);
  add(view?.withdraw?.sepoliaTx);
  for (const e of record.bridgeOut.earlier ?? []) add(e.sepoliaTx);
  add(record.bridgeOut.sepoliaTx);
  return out;
}

/** The sponsor's states that agree with a payout that has arrived: the bridge is closing the
 *  request (`withdrawing`, `bridging_back`), or it closed it (`done`). Any other one, after the whole
 *  amount arrived, contradicts it, and the page shows it. */
export const AGREES_WITH_ARRIVAL: ReadonlySet<SwapView['state']> = new Set(['withdrawing', 'bridging_back', 'done']);

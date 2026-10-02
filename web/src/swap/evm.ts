// The Sepolia side of a swap, through the connected wallet's EIP-1193 provider: the two funding
// transactions (the exact ERC20 amount and the sized sweep ETH to the deposit address), balance
// reads, receipts, and the "start swap" / sponsor signatures (eth_signTypedData_v4). The page never
// holds an EVM key.
//
// The port is BOUND to one chain and one account (P4.2-fix C9): before every transaction it asks the
// wallet itself (`eth_chainId`, `eth_accounts`) and refuses unless it is still Sepolia and the swap's
// account, and every transaction names the chain (`chainId`: a wallet that honours it refuses to
// send on another one).

import { getAddress } from 'ethers';

import type { Eip1193Provider } from '../wallet/eip1193.js';
import type { TypedData, TypedDataSigner } from './ports.js';

const TRANSFER = '0xa9059cbb';
const BALANCE_OF = '0x70a08231';
const word = (v: bigint | string) =>
  (typeof v === 'bigint' ? v.toString(16) : v.toLowerCase().replace(/^0x/, '')).padStart(64, '0');

/** ERC20 `transfer(to, amount)` call data. */
export function transferData(to: string, amount: bigint): string {
  if (amount <= 0n) throw new RangeError('the amount must be positive');
  return `${TRANSFER}${word(getAddress(to))}${word(amount)}`;
}

export class EvmError extends Error {
  override name = 'EvmError';
  constructor(
    message: string,
    readonly declined = false,
  ) {
    super(message);
  }
}

const code = (e: unknown) => (e as { code?: unknown } | null)?.code;

function friendly(e: unknown, what: string): EvmError {
  if (e instanceof EvmError) return e;
  if (code(e) === 4001) return new EvmError(`You declined ${what} in your wallet.`, true);
  const msg = (e as { message?: unknown } | null)?.message;
  return new EvmError(
    `Your wallet could not complete ${what}${typeof msg === 'string' && msg ? `: ${msg.slice(0, 160)}` : '.'}`,
  );
}

const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v))
    throw new EvmError('The wallet answered a read with something unexpected.');
  return v === '0x' ? 0n : BigInt(v);
};

/** A log of a mined transaction: the emitting contract, its topics and data (lowercase hex). */
export interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
}

/** A mined transaction's receipt as the page reads it (P4.2-fix4: the arrival of the tokens). */
export interface MinedReceipt {
  hash: string;
  status: 'success' | 'reverted';
  blockNumber: number;
  logs: readonly ReceiptLog[];
}

const HEX32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;

/**
 * An `eth_getTransactionReceipt` answer for `hash`, checked: null while the transaction is pending or
 * unknown, and for an answer that is not a receipt of that transaction (another hash, no status, no
 * block). A log that is not well formed is dropped (it cannot be the transfer the page looks for).
 */
export function parseReceipt(raw: unknown, hash: string): MinedReceipt | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { transactionHash?: unknown; status?: unknown; blockNumber?: unknown; logs?: unknown };
  const want = hash.toLowerCase();
  if (typeof r.transactionHash === 'string' && r.transactionHash.toLowerCase() !== want) return null;
  if (r.status !== '0x1' && r.status !== '0x0') return null;
  if (typeof r.blockNumber !== 'string' || !/^0x[0-9a-fA-F]{1,16}$/.test(r.blockNumber)) return null;
  const logs: ReceiptLog[] = [];
  for (const l of Array.isArray(r.logs) ? (r.logs as unknown[]) : []) {
    const x = l as { address?: unknown; topics?: unknown; data?: unknown; removed?: unknown } | null;
    if (!x || x.removed === true || typeof x.address !== 'string' || typeof x.data !== 'string') continue;
    const address = x.address.toLowerCase();
    const topics = Array.isArray(x.topics) ? x.topics.map((t) => (typeof t === 'string' ? t.toLowerCase() : '')) : [];
    if (!ADDRESS.test(address) || topics.some((t) => !HEX32.test(t)) || !/^0x([0-9a-fA-F]{2})*$/.test(x.data)) continue;
    logs.push({ address, topics, data: x.data.toLowerCase() });
  }
  return {
    hash: want,
    status: r.status === '0x1' ? 'success' : 'reverted',
    blockNumber: Number.parseInt(r.blockNumber, 16),
    logs,
  };
}

export interface EvmPort {
  address: string;
  /** Throws an `EvmError` unless the wallet is on the bound chain with the bound account right now. */
  ready(): Promise<void>;
  /** `ready()`, then the transaction, with the bound chain's id in it. */
  sendTransaction(tx: { to: string; data?: string; value?: bigint }, what: string): Promise<string>;
  ethBalance(holder: string): Promise<bigint>;
  erc20Balance(token: string, holder: string): Promise<bigint>;
  /** The receipt's outcome, or null while it is pending. */
  receipt(hash: string): Promise<'success' | 'reverted' | null>;
  /** The mined receipt with its logs, read on the bound chain (`ready()` first: never another
   *  network's), or null while it is pending or unknown (P4.2-fix4). */
  minedReceipt(hash: string): Promise<MinedReceipt | null>;
}

/** The connected account on one chain (`chain`: its id and name, e.g. Sepolia's `0xaa36a7`). */
export function evmPort(
  provider: Eip1193Provider,
  address: string,
  chain: { chainIdHex: string; chainName: string },
): EvmPort {
  const from = getAddress(address);
  const chainId = chain.chainIdHex.toLowerCase();
  const ready = async () => {
    let id: unknown;
    let accounts: unknown;
    try {
      [id, accounts] = await Promise.all([
        provider.request({ method: 'eth_chainId' }),
        provider.request({ method: 'eth_accounts' }),
      ]);
    } catch {
      throw new EvmError('Your wallet did not say which network and account it is on. Nothing was sent.');
    }
    if (typeof id !== 'string' || id.toLowerCase() !== chainId)
      throw new EvmError(
        `Your wallet is not on ${chain.chainName}. Switch it back to ${chain.chainName}: nothing was sent.`,
      );
    const first = Array.isArray(accounts) ? accounts[0] : undefined;
    const current = (() => {
      try {
        return typeof first === 'string' ? getAddress(first) : null;
      } catch {
        return null;
      }
    })();
    if (current !== from)
      throw new EvmError(
        'Your wallet switched to another account. Switch back to the one that started this swap: nothing was sent.',
      );
  };
  return {
    address: from,
    ready,
    async sendTransaction(tx, what) {
      await ready();
      try {
        const hash = await provider.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from,
              to: getAddress(tx.to),
              ...(tx.data ? { data: tx.data } : {}),
              value: `0x${(tx.value ?? 0n).toString(16)}`,
              chainId,
            },
          ],
        });
        if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash))
          throw new EvmError('The wallet did not return a transaction hash.');
        return hash;
      } catch (e) {
        throw friendly(e, what);
      }
    },
    async ethBalance(holder) {
      return quantity(await provider.request({ method: 'eth_getBalance', params: [getAddress(holder), 'latest'] }));
    },
    async erc20Balance(token, holder) {
      return quantity(
        await provider.request({
          method: 'eth_call',
          params: [{ to: getAddress(token), data: `${BALANCE_OF}${word(getAddress(holder))}` }, 'latest'],
        }),
      );
    },
    async receipt(hash) {
      const r = (await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as {
        status?: string;
      } | null;
      if (!r || typeof r.status !== 'string') return null;
      return r.status === '0x1' ? 'success' : 'reverted';
    },
    async minedReceipt(hash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
      await ready();
      return parseReceipt(await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }), hash);
    },
  };
}

/** The connected account as a typed-data signer. */
export function walletSigner(provider: Eip1193Provider, address: string): TypedDataSigner {
  const from = getAddress(address);
  return {
    address: from,
    async signTypedData(typedData: TypedData) {
      try {
        const sig = await provider.request({
          method: 'eth_signTypedData_v4',
          params: [from, JSON.stringify(typedData)],
        });
        if (typeof sig !== 'string') throw new EvmError('The wallet did not return a signature.');
        return sig;
      } catch (e) {
        throw friendly(e, 'the signature');
      }
    },
  };
}

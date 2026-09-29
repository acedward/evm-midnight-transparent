// The Sepolia side of a swap, through the connected wallet's EIP-1193 provider: the two funding
// transactions (the exact ERC20 amount and the sized sweep ETH to the deposit address), balance
// reads, receipts, and the "start swap" / sponsor signatures (eth_signTypedData_v4). The page never
// holds an EVM key.

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

export interface EvmPort {
  address: string;
  sendTransaction(tx: { to: string; data?: string; value?: bigint }, what: string): Promise<string>;
  ethBalance(holder: string): Promise<bigint>;
  erc20Balance(token: string, holder: string): Promise<bigint>;
  /** The receipt's outcome, or null while it is pending. */
  receipt(hash: string): Promise<'success' | 'reverted' | null>;
}

export function evmPort(provider: Eip1193Provider, address: string): EvmPort {
  const from = getAddress(address);
  return {
    address: from,
    async sendTransaction(tx, what) {
      try {
        const hash = await provider.request({
          method: 'eth_sendTransaction',
          params: [
            {
              from,
              to: getAddress(tx.to),
              ...(tx.data ? { data: tx.data } : {}),
              value: `0x${(tx.value ?? 0n).toString(16)}`,
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

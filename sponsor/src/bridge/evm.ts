// Sepolia through JSON-RPC, read-only (copied from MN Bank's relay, acedward/passport-evm-dapp @
// 911647b, relay/src/bridge/backend.ts `jsonRpcEvmReader`, plus the base fee for the sweep sizing).
// The URL usually carries an API key: it is never logged, and errors say only which method failed
// (the logger also redacts the URL).

import type { EvmReader, EvmTransaction, EvmTransfer } from '../swaps/backend.js';

const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error('not a hex quantity');
  return v === '0x' ? 0n : BigInt(v);
};

/** keccak256("Transfer(address,address,uint256)"). */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Blocks per `eth_getLogs` call (well inside every public provider's range limit). */
export const LOG_CHUNK_BLOCKS = 5_000n;

const optQuantity = (v: unknown): bigint | undefined => (v === undefined || v === null ? undefined : quantity(v));

/** An `eth_getTransactionByHash` answer for `hash`, checked: null while it is pending (no block) or
 *  unknown, and for an answer about another transaction (audit U2). */
export function parseTransaction(raw: unknown, hash: string): EvmTransaction | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const want = hash.toLowerCase();
  if (typeof t.hash !== 'string' || t.hash.toLowerCase() !== want) return null;
  if (t.blockNumber === null || t.blockNumber === undefined) return null;
  if (typeof t.from !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(t.from)) return null;
  const gasPrice = optQuantity(t.gasPrice);
  const maxFeePerGas = optQuantity(t.maxFeePerGas) ?? gasPrice;
  const maxPriorityFeePerGas = optQuantity(t.maxPriorityFeePerGas) ?? gasPrice;
  if (maxFeePerGas === undefined) return null;
  return {
    hash: want,
    from: t.from.toLowerCase(),
    nonce: quantity(t.nonce),
    gasLimit: quantity(t.gas),
    maxFeePerGas,
    ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
  };
}

const word = (address: string) => `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
const hexQ = (n: bigint) => `0x${n.toString(16)}`;

/** A JSON-RPC error the node answered (as opposed to an unreachable or failing endpoint). */
export class EvmRpcError extends Error {
  override name = 'EvmRpcError';
  constructor(
    readonly method: string,
    readonly rpcMessage: string,
    readonly code: number | undefined,
  ) {
    super(`Sepolia ${method}: ${rpcMessage}`);
  }
}

/** An estimate the node refused because the call cannot execute (a revert, out of gas, no funds). */
const cannotExecute = (e: unknown) =>
  e instanceof EvmRpcError && (e.code === 3 || /revert|exceeds|insufficient|out of gas/i.test(e.rpcMessage));

export function jsonRpcEvmReader(
  url: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
): EvmReader {
  let id = 0;
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new Error(`Sepolia ${method}: unreachable`);
    }
    const body = (await res.json().catch(() => null)) as {
      result?: unknown;
      error?: { message?: string; code?: number };
    } | null;
    if (body?.error) throw new EvmRpcError(method, String(body.error.message ?? 'error'), body.error.code);
    if (!res.ok || !body) throw new Error(`Sepolia ${method}: ${res.status}`);
    return body.result;
  };
  return {
    ethBalance: async (address) => quantity(await call('eth_getBalance', [address, 'latest'])),
    erc20Balance: async (token, holder) =>
      quantity(
        await call('eth_call', [
          { to: token, data: `0x70a08231${holder.toLowerCase().replace(/^0x/, '').padStart(64, '0')}` },
          'latest',
        ]),
      ),
    nonce: async (address, tag) => quantity(await call('eth_getTransactionCount', [address, tag])),
    baseFeePerGas: async () => {
      const block = (await call('eth_getBlockByNumber', ['latest', false])) as { baseFeePerGas?: unknown } | null;
      return quantity(block?.baseFeePerGas);
    },
    async estimateTransferGas(token, from, to, amount) {
      const data = `0xa9059cbb${word(to).slice(2)}${amount.toString(16).padStart(64, '0')}`;
      try {
        return quantity(await call('eth_estimateGas', [{ from, to: token, data }, 'latest']));
      } catch (e) {
        if (cannotExecute(e)) return 'reverts';
        throw e;
      }
    },
    blockNumber: async () => quantity(await call('eth_blockNumber', [])),
    async transfersFrom(token, from, fromBlock) {
      const latest = quantity(await call('eth_blockNumber', []));
      const out: EvmTransfer[] = [];
      for (let start = fromBlock < 0n ? 0n : fromBlock; start <= latest; start += LOG_CHUNK_BLOCKS) {
        const end = start + LOG_CHUNK_BLOCKS - 1n < latest ? start + LOG_CHUNK_BLOCKS - 1n : latest;
        const logs = (await call('eth_getLogs', [
          {
            address: token,
            fromBlock: hexQ(start),
            toBlock: hexQ(end),
            topics: [ERC20_TRANSFER_TOPIC, word(from)],
          },
        ])) as {
          transactionHash?: unknown;
          topics?: unknown;
          data?: unknown;
          blockNumber?: unknown;
          removed?: unknown;
        }[];
        if (!Array.isArray(logs)) throw new Error('Sepolia eth_getLogs: not a list');
        for (const l of logs) {
          const topics = Array.isArray(l.topics) ? (l.topics as string[]) : [];
          if (l.removed === true || topics.length < 3 || String(topics[0]).toLowerCase() !== ERC20_TRANSFER_TOPIC)
            continue;
          out.push({
            txHash: String(l.transactionHash).toLowerCase(),
            to: `0x${String(topics[2]).slice(-40).toLowerCase()}`,
            amount: quantity(l.data),
            block: quantity(l.blockNumber),
          });
        }
      }
      return out;
    },
    transaction: async (hash) => parseTransaction(await call('eth_getTransactionByHash', [hash]), hash),
  };
}

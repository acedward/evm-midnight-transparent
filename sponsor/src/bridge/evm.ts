// Sepolia through JSON-RPC, read-only (copied from MN Bank's relay, acedward/passport-evm-dapp @
// 911647b, relay/src/bridge/backend.ts `jsonRpcEvmReader`, plus the base fee for the sweep sizing).
// The URL usually carries an API key: it is never logged, and errors say only which method failed
// (the logger also redacts the URL).

import type { EvmReader } from '../swaps/backend.js';

const quantity = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v)) throw new Error('not a hex quantity');
  return v === '0x' ? 0n : BigInt(v);
};

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
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: { message?: string } } | null;
    if (!res.ok || !body || body.error) throw new Error(`Sepolia ${method}: ${body?.error?.message ?? res.status}`);
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
  };
}

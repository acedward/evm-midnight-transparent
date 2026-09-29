// A built-in mock EVM wallet for mock mode (`config.json` `mock.evmWallet: true`), so the whole swap
// can be clicked through in a browser with no extension and no real funds: a random key made in the
// page, fake Sepolia balances (1 ETH and 1,000 of every vault token), transfers that only move those
// numbers, and real EIP-712 signatures. Announced through EIP-6963 as "Mock wallet (no real funds)".
// The Playwright specs use their own test wallet (test/e2e/test-wallet.ts) instead.

import type { TokenRegistry } from '@evm-midnight-transparent/core';
import { Wallet } from 'ethers';

const hexq = (v: bigint) => `0x${v.toString(16)}`;

export function announceMockEvmWallet(registry: TokenRegistry, win: Window = window): { address: string } {
  const wallet = Wallet.createRandom();
  const me = wallet.address.toLowerCase();
  const eth = new Map<string, bigint>([[me, 10n ** 18n]]);
  const erc20 = new Map<string, bigint>();
  for (const t of registry.tokens)
    if (t.sepoliaAddress) erc20.set(`${t.sepoliaAddress.toLowerCase()}:${me}`, 1000n * 10n ** BigInt(t.decimals));
  let chainId = '0xaa36a7';
  let sent = 0;
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const ethOf = (a: string) => eth.get(a.toLowerCase()) ?? 0n;
  const tokenOf = (token: string, holder: string) => erc20.get(`${token.toLowerCase()}:${holder.toLowerCase()}`) ?? 0n;

  const provider = {
    async request({ method, params = [] }: { method: string; params?: unknown[] }): Promise<unknown> {
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [wallet.address];
        case 'eth_chainId':
          return chainId;
        case 'wallet_switchEthereumChain':
          chainId = String((params[0] as { chainId: string }).chainId).toLowerCase();
          for (const h of listeners.chainChanged ?? []) h(chainId);
          return null;
        case 'eth_getBalance':
          return hexq(ethOf(String(params[0])));
        case 'eth_call': {
          const c = params[0] as { to: string; data: string };
          if (!c.data?.startsWith('0x70a08231')) throw Object.assign(new Error('unsupported call'), { code: -32000 });
          return `0x${tokenOf(c.to, `0x${c.data.slice(34, 74)}`)
            .toString(16)
            .padStart(64, '0')}`;
        }
        case 'eth_sendTransaction': {
          const tx = params[0] as { to: string; data?: string; value?: string };
          const value = BigInt(tx.value ?? '0x0');
          const fee = 60_000n * 2_000_000_000n;
          if (ethOf(me) < value + fee) throw Object.assign(new Error('insufficient funds for gas'), { code: -32000 });
          eth.set(me, ethOf(me) - value - fee);
          if (tx.data?.startsWith('0xa9059cbb')) {
            const to = `0x${tx.data.slice(34, 74)}`.toLowerCase();
            const amount = BigInt(`0x${tx.data.slice(74)}`);
            if (tokenOf(tx.to, me) < amount)
              throw Object.assign(new Error('transfer amount exceeds balance'), { code: -32000 });
            erc20.set(`${tx.to.toLowerCase()}:${me}`, tokenOf(tx.to, me) - amount);
            erc20.set(`${tx.to.toLowerCase()}:${to}`, tokenOf(tx.to, to) + amount);
          } else {
            eth.set(tx.to.toLowerCase(), ethOf(tx.to) + value);
          }
          return `0x${(++sent).toString(16).padStart(64, 'd')}`;
        }
        case 'eth_getTransactionReceipt':
          return { status: '0x1', transactionHash: params[0] };
        case 'eth_signTypedData_v4': {
          const td = JSON.parse(String(params[1])) as {
            domain: Record<string, unknown>;
            types: Record<string, Array<{ name: string; type: string }>>;
            message: Record<string, unknown>;
          };
          const { EIP712Domain: _domain, ...types } = td.types;
          return wallet.signTypedData(td.domain, types, td.message);
        }
        default:
          throw Object.assign(new Error(`unsupported method ${method}`), { code: 4200 });
      }
    },
    on(event: string, h: (...a: unknown[]) => void) {
      (listeners[event] ??= []).push(h);
    },
    removeListener(event: string, h: (...a: unknown[]) => void) {
      listeners[event] = (listeners[event] ?? []).filter((x) => x !== h);
    },
  };
  const info = {
    uuid: '7d3f0a52-1c6e-4b8a-9f00-00000000e3e0',
    name: 'Mock wallet (no real funds)',
    icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 20 20%22%3E%3Crect width=%2220%22 height=%2220%22 fill=%22%23152c55%22/%3E%3C/svg%3E',
    rdns: 'mock.evm-midnight-swap',
  };
  const announce = () =>
    win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  win.addEventListener('eip6963:requestProvider', announce);
  announce();
  return { address: wallet.address };
}

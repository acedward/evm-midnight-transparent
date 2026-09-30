// An EIP-1193 wallet for the browser specs, announced through EIP-6963 as "EMT Test Wallet" (rdns
// test.evm-midnight-swap, which mock mode lets fund a swap). Adapted from MN Bank
// (acedward/passport-evm-dapp @ 911647b, test/e2e/test-wallet.ts).
//
// The key is an ethers Wallet made fresh per run (or given, to reopen the same wallet in a new tab)
// and it stays in the Node test process: the page only sees a provider whose requests are forwarded
// through `page.exposeFunction`.
//
// FAKE mode (the default) answers Sepolia reads from `sepolia` (for any holder: the mock sponsor
// reads the deposit address through it) and "sends" transactions by moving those balances. LIVE mode
// (`live: { rpcUrl }`, for P3's capped runs with the owner's key read in-process) forwards reads to a
// public Sepolia RPC and signs and broadcasts `eth_sendTransaction` with the key.
//
// `nonDeterministic: true` signs typed data with a RANDOM nonce (valid, low-s, but different every
// time), the way a wallet without RFC 6979 would: the page's determinism warning (Q4).

import type { Page } from '@playwright/test';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  JsonRpcProvider,
  NonceManager,
  TypedDataEncoder,
  Wallet,
  getBytes,
  hexlify,
  type TransactionRequest,
} from 'ethers';

export interface TestWallet {
  address: string;
  /** The key, for reopening a FAKE-mode wallet in another tab; '' in LIVE mode (an owner's key never
   *  leaves `installTestWallet`). */
  privateKey: string;
  /** Every request the page made, in order. */
  calls: Array<{ method: string; params: unknown }>;
  /** Every transaction the page sent. */
  sent: Array<{ to: string; data: string; value: bigint; hash: string }>;
}

export interface FakeSepolia {
  /** Wei the connected address holds. */
  ethWei?: bigint;
  /** ERC20 balances of the connected address by token address (lowercase), in base units. */
  erc20?: Record<string, bigint>;
  /** Balances of OTHER addresses (lowercase): wei, and ERC20s by `token:holder`. */
  others?: { eth?: Record<string, bigint>; erc20?: Record<string, bigint> };
}

export interface LiveSepolia {
  /** A public Sepolia RPC (never a keyed URL: it would reach the test logs). */
  rpcUrl: string;
}

const hexq = (v: bigint) => `0x${v.toString(16)}`;
let sentCounter = 0;

export async function installTestWallet(
  page: Page,
  opts: {
    startChainId?: string;
    sepolia?: FakeSepolia;
    privateKey?: string;
    live?: LiveSepolia;
    nonDeterministic?: boolean;
  } = {},
): Promise<TestWallet> {
  const rpc = opts.live ? new JsonRpcProvider(opts.live.rpcUrl, 11155111, { staticNetwork: true }) : null;
  const wallet = opts.privateKey ? new Wallet(opts.privateKey, rpc ?? undefined) : Wallet.createRandom();
  // LIVE: nonces are counted here, so two sends in a row never reuse one (a load-balanced public RPC
  // can answer a stale pending count right after the first send).
  const sender = rpc ? new NonceManager(wallet) : null;
  let chainId = opts.startChainId ?? '0x1'; // mainnet: the dApp must ask to switch to Sepolia
  const calls: TestWallet['calls'] = [];
  const sent: TestWallet['sent'] = [];
  const me = wallet.address.toLowerCase();
  const s = (opts.sepolia ??= {});
  s.others ??= {};
  const fakeEth = (a: string) => (a.toLowerCase() === me ? (s.ethWei ?? 0n) : (s.others?.eth?.[a.toLowerCase()] ?? 0n));
  const fakeErc20 = (token: string, holder: string) =>
    holder.toLowerCase() === me
      ? (s.erc20?.[token.toLowerCase()] ?? 0n)
      : (s.others?.erc20?.[`${token.toLowerCase()}:${holder.toLowerCase()}`] ?? 0n);

  await page.exposeFunction('__emtTestWallet', async (method: string, params: unknown[]) => {
    calls.push({ method, params });
    if (
      rpc &&
      [
        'eth_getBalance',
        'eth_call',
        'eth_getTransactionReceipt',
        'eth_getTransactionCount',
        'eth_blockNumber',
        'eth_estimateGas',
        'eth_gasPrice',
      ].includes(method)
    ) {
      try {
        return await rpc.send(method, params);
      } catch (e) {
        return { __error: { code: -32603, message: e instanceof Error ? e.message : String(e) } };
      }
    }
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return [wallet.address];
      case 'eth_chainId':
        return chainId;
      case 'wallet_switchEthereumChain':
        chainId = String((params[0] as { chainId: string }).chainId).toLowerCase();
        return null;
      case 'eth_getBalance':
        return hexq(fakeEth(String(params[0])));
      case 'eth_call': {
        const call = params[0] as { to?: string; data?: string };
        const holder = call.data && call.data.length >= 74 ? `0x${call.data.slice(34, 74)}` : me;
        return `0x${fakeErc20(String(call.to), holder).toString(16).padStart(64, '0')}`;
      }
      case 'eth_sendTransaction': {
        const tx = params[0] as { from?: string; to: string; data?: string; value?: string };
        const value = BigInt(tx.value ?? '0x0');
        if (sender) {
          const req: TransactionRequest = { to: tx.to, data: tx.data ?? '0x', value };
          try {
            const res = await sender.sendTransaction(req);
            sent.push({ to: tx.to, data: tx.data ?? '', value, hash: res.hash });
            return res.hash;
          } catch (e) {
            sender.reset();
            return { __error: { code: -32603, message: e instanceof Error ? e.message.slice(0, 300) : String(e) } };
          }
        }
        // FAKE: move the balances the page (and the mock sponsor) will read back.
        s.others ??= {};
        if (tx.data?.startsWith('0xa9059cbb')) {
          const to = `0x${tx.data.slice(34, 74)}`.toLowerCase();
          const amount = BigInt(`0x${tx.data.slice(74)}`);
          const key = `${tx.to.toLowerCase()}:${to}`;
          (s.others.erc20 ??= {})[key] = (s.others.erc20[key] ?? 0n) + amount;
          (s.erc20 ??= {})[tx.to.toLowerCase()] = (s.erc20[tx.to.toLowerCase()] ?? 0n) - amount;
        } else {
          const to = tx.to.toLowerCase();
          (s.others.eth ??= {})[to] = (s.others.eth[to] ?? 0n) + value;
          s.ethWei = (s.ethWei ?? 0n) - value;
        }
        const hash = `0x${(++sentCounter).toString(16).padStart(64, 'e')}`;
        sent.push({ to: tx.to, data: tx.data ?? '', value, hash });
        return hash;
      }
      case 'eth_getTransactionReceipt':
        return { status: '0x1', transactionHash: params[0] };
      case 'eth_signTypedData_v4': {
        const td = JSON.parse(String(params[1])) as {
          domain: Record<string, unknown>;
          types: Record<string, Array<{ name: string; type: string }>>;
          message: Record<string, unknown>;
        };
        const { EIP712Domain: _d, ...types } = td.types;
        if (opts.nonDeterministic) {
          const digest = getBytes(TypedDataEncoder.hash(td.domain, types, td.message));
          const sig = secp256k1.sign(digest, getBytes(wallet.privateKey), { extraEntropy: true });
          return hexlify(new Uint8Array([...sig.toCompactRawBytes(), 27 + sig.recovery]));
        }
        return wallet.signTypedData(td.domain, types, td.message);
      }
      default:
        return { __error: { code: 4200, message: `unsupported method ${method}` } };
    }
  });

  await page.addInitScript(() => {
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const bridge = (window as unknown as { __emtTestWallet: (m: string, p: unknown[]) => Promise<unknown> })
      .__emtTestWallet;
    const provider = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        const result = await bridge(method, params ?? []);
        const err = (result as { __error?: { code: number; message: string } } | null)?.__error;
        if (err) throw Object.assign(new Error(err.message), { code: err.code });
        if (method === 'wallet_switchEthereumChain') {
          const id = (params?.[0] as { chainId: string }).chainId;
          for (const h of listeners.chainChanged ?? []) h(id);
        }
        return result;
      },
      on(event: string, h: (...a: unknown[]) => void) {
        (listeners[event] ??= []).push(h);
      },
      removeListener(event: string, h: (...a: unknown[]) => void) {
        listeners[event] = (listeners[event] ?? []).filter((x) => x !== h);
      },
    };
    const info = {
      uuid: '0f5c2a4e-6b1d-4c38-9a57-00000000e4e0',
      name: 'EMT Test Wallet',
      icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E',
      rdns: 'test.evm-midnight-swap',
    };
    const announce = () =>
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });

  return { address: wallet.address, privateKey: rpc ? '' : wallet.privateKey, calls, sent };
}

/** The same wallet (the same key and Sepolia state) in another tab: a user who comes back. */
export function reopenTestWallet(page: Page, first: TestWallet, sepolia: FakeSepolia): Promise<TestWallet> {
  const same = { sepolia } as Parameters<typeof installTestWallet>[1] & object;
  same.privateKey = first.privateKey;
  return installTestWallet(page, same);
}

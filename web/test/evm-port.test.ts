// The Sepolia port (src/swap/evm.ts), P4.2-fix C9 (the audit's F-B6 / F-A13): bound to one chain and
// one account. Every transaction first asks the wallet itself for its network and account, refuses
// unless they are still Sepolia and the swap's account, and names the chain in the transaction.

import { describe, expect, it } from 'vitest';

import { EvmError, evmPort } from '../src/swap/evm.js';
import type { Eip1193Provider } from '../src/wallet/eip1193.js';

const ME = '0x484738A67858305Edfc139B194Ed430Fe4D8e56b';
const SEPOLIA = { chainIdHex: '0xaa36a7', chainName: 'Sepolia' };

function wallet(state: { chainId: string; accounts: unknown; failChainId?: boolean }) {
  const calls: Array<{ method: string; params?: unknown }> = [];
  const provider: Eip1193Provider = {
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === 'eth_chainId') {
        if (state.failChainId) throw Object.assign(new Error('locked'), { code: 4100 });
        return state.chainId;
      }
      if (method === 'eth_accounts') return state.accounts;
      if (method === 'eth_sendTransaction') return `0x${'ab'.repeat(32)}`;
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider, calls, sends: () => calls.filter((c) => c.method === 'eth_sendTransaction') };
}

describe('the Sepolia port is bound to Sepolia and the swap account (P4.2-fix C9)', () => {
  it('sends on Sepolia with the account, and names the chain in the transaction', async () => {
    const w = wallet({ chainId: '0xaa36a7', accounts: [ME.toLowerCase()] });
    const port = evmPort(w.provider, ME, SEPOLIA);
    await expect(port.ready()).resolves.toBeUndefined();
    const hash = await port.sendTransaction({ to: ME, value: 5n }, 'a test');
    expect(hash).toBe(`0x${'ab'.repeat(32)}`);
    expect(w.sends()).toHaveLength(1);
    expect((w.sends()[0]!.params as Array<Record<string, unknown>>)[0]).toMatchObject({
      from: ME,
      chainId: '0xaa36a7',
      value: '0x5',
    });
  });

  it('refuses to send on another chain: nothing reaches eth_sendTransaction', async () => {
    const w = wallet({ chainId: '0x1', accounts: [ME] });
    const port = evmPort(w.provider, ME, SEPOLIA);
    await expect(port.sendTransaction({ to: ME, value: 5n }, 'a test')).rejects.toThrow(/not on Sepolia/);
    await expect(port.ready()).rejects.toBeInstanceOf(EvmError);
    expect(w.sends()).toEqual([]);
  });

  it('refuses another account, no account, and a wallet that does not answer', async () => {
    for (const accounts of [[`0x${'12'.repeat(20)}`], [], null, ['not an address']]) {
      const w = wallet({ chainId: '0xaa36a7', accounts });
      await expect(
        evmPort(w.provider, ME, SEPOLIA).sendTransaction({ to: ME }, 'a test'),
        String(accounts),
      ).rejects.toThrow(/another account/);
      expect(w.sends()).toEqual([]);
    }
    const locked = wallet({ chainId: '0xaa36a7', accounts: [ME], failChainId: true });
    await expect(evmPort(locked.provider, ME, SEPOLIA).sendTransaction({ to: ME }, 'a test')).rejects.toThrow(
      /did not say which network/,
    );
    expect(locked.sends()).toEqual([]);
  });
});

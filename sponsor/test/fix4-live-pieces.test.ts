// Plan 00048 P4.2-fix4 (lane FS4): the live backend's new pieces, offline. The settle hook records the
// REAL transaction's identifiers (G-BRIDGE's live completeDeposit) before it reaches the node; the
// indexer lookup and the Sepolia reads parse the exact shapes those services answer with (audit T1,
// T2). No network.

import { readFileSync } from 'node:fs';

import * as ledger from '@midnightntwrk/ledger-v9';
import { describe, expect, it } from 'vitest';

import { ERC20_TRANSFER_TOPIC, LOG_CHUNK_BLOCKS, jsonRpcEvmReader } from '../src/bridge/evm.js';
import { findTransaction } from '../src/bridge/live-backend.js';
import { identifiersOf, sponsorWalletProvider } from '../src/bridge/vault.js';
import type { OpenedWallet } from '../src/sponsor/facade.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const fixture = JSON.parse(
  readFileSync(new URL('../../packages/wallet/test/fixtures/g-bridge-complete-deposit.json', import.meta.url), 'utf8'),
) as { hash: string; identifiers: string[]; midnightJsTxId: string; raw: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('T1: the sponsor records what identifies its own settle before it reaches the node', () => {
  it('the provider tells the REAL transaction’s identifiers and the balancing’s time to live, then submits', async () => {
    const tx: Any = (ledger.Transaction as Any).deserialize(
      'signature',
      'proof',
      'binding',
      Buffer.from(fixture.raw, 'hex'),
    );
    const order: string[] = [];
    const handle = {
      wallet: {
        balanceUnboundTransaction: async () => ({ recipe: true }),
        signRecipe: async (r: unknown) => r,
        finalizeRecipe: async () => tx,
        submitTransaction: async () => {
          order.push('submit');
          return fixture.midnightJsTxId;
        },
      },
      shieldedSecretKeys: {},
      dustSecretKey: {},
      unshieldedKeystore: { signDataAsync: async () => 'sig' },
    };
    const seen: { identifiers: string[]; expiresAtMs: number }[] = [];
    const p = sponsorWalletProvider({ handle } as unknown as OpenedWallet, 'cc'.repeat(32), 'ee'.repeat(32), 60_000, {
      onSubmit: (s) => {
        order.push('recorded');
        seen.push(s);
      },
    });
    const ttl = new Date(1_790_717_160_000);
    const balanced = await p.balanceTx({}, ttl);
    expect(await p.submitTx(balanced)).toBe(fixture.midnightJsTxId);
    expect(order).toEqual(['recorded', 'submit']);
    expect(seen).toEqual([{ identifiers: fixture.identifiers, expiresAtMs: ttl.getTime() }]);
    expect(identifiersOf(tx)).toContain(fixture.midnightJsTxId);
  });

  it('a hook that cannot record stops the submission (nothing reaches the node unrecorded)', async () => {
    const tx: Any = (ledger.Transaction as Any).deserialize(
      'signature',
      'proof',
      'binding',
      Buffer.from(fixture.raw, 'hex'),
    );
    let submitted = false;
    const handle = {
      wallet: {
        submitTransaction: async () => {
          submitted = true;
          return 'x';
        },
      },
    };
    const p = sponsorWalletProvider({ handle } as unknown as OpenedWallet, 'cc'.repeat(32), 'ee'.repeat(32), 60_000, {
      onSubmit: () => {
        throw new Error('the store is full');
      },
    });
    expect(() => p.submitTx(tx)).toThrow('the store is full');
    expect(submitted).toBe(false);
  });
});

describe('T1: a transaction looked up by identifier on the indexer, after its head', () => {
  const head = { data: { block: { height: 712_732, timestamp: 1_790_900_000_000 } } };
  const calls: string[] = [];
  const indexer = (answer: unknown) => async (_url: string, init: RequestInit) => {
    const q = JSON.parse(String(init.body)) as { query: string; variables?: { id?: string } };
    calls.push(q.query.includes('SPONSOR_HEAD') ? 'head' : `tx:${q.variables?.id}`);
    return json(q.query.includes('SPONSOR_HEAD') ? head : answer);
  };

  it('found: the hash, height and success (the shape `transactions(offset: {identifier})` answers)', async () => {
    calls.length = 0;
    const r = await findTransaction(
      'http://indexer',
      `0x${fixture.midnightJsTxId.toUpperCase()}`,
      indexer({
        data: {
          transactions: [{ hash: fixture.hash, block: { height: 679_341 }, transactionResult: { status: 'SUCCESS' } }],
        },
      }),
    );
    expect(r).toEqual({
      found: { hash: fixture.hash, height: 679_341, success: true },
      asOf: { height: 712_732, timeMs: 1_790_900_000_000 },
    });
    expect(calls).toEqual(['head', `tx:${fixture.midnightJsTxId}`]); // the head FIRST
  });

  it('not found: null as of the head; a failed transaction is not a success; an error answer throws', async () => {
    expect(
      (await findTransaction('http://i', 'ab'.repeat(33), indexer({ data: { transactions: [] } }))).found,
    ).toBeNull();
    const failed = await findTransaction(
      'http://i',
      'ab'.repeat(33),
      indexer({
        data: {
          transactions: [{ hash: 'cd'.repeat(32), block: { height: 1 }, transactionResult: { status: 'FAILURE' } }],
        },
      }),
    );
    expect(failed.found?.success).toBe(false);
    await expect(
      findTransaction('http://i', 'ab'.repeat(33), indexer({ errors: [{ message: 'boom' }] })),
    ).rejects.toThrow();
    await expect(findTransaction('http://i', 'not hex', indexer({ data: { transactions: [] } }))).rejects.toThrow();
  });
});

describe('T1 / T2: the Sepolia reads', () => {
  type Rpc = { method: string; params: unknown[] };
  const rpc = (answer: (q: Rpc) => unknown) => {
    const seen: Rpc[] = [];
    const fetchImpl = async (_u: string, init?: RequestInit) => {
      const q = JSON.parse(String(init!.body)) as Rpc & { id: number };
      seen.push(q);
      const a = answer(q);
      if (a instanceof Response) return a;
      return json({ jsonrpc: '2.0', id: q.id, ...(a as object) });
    };
    return { reader: jsonRpcEvmReader('http://rpc', fetchImpl), seen };
  };
  const ERC20_ADDRESS = '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52';
  const FROM = '0xFA0D1f6448c87d7a5ab437492Ca5865D68C4f55F';
  const VAULT_EVM = '0x648216975e722494bFF92E88FFc68C8F8d438FaA';

  it('estimateTransferGas: the transfer’s calldata from the deposit address; a revert means it cannot execute; an outage throws', async () => {
    const ok = rpc(() => ({ result: '0x73ed' }));
    expect(await ok.reader.estimateTransferGas(ERC20_ADDRESS, FROM, VAULT_EVM, 1_000_000n)).toBe(29_677n);
    expect(ok.seen[0]).toMatchObject({
      method: 'eth_estimateGas',
      params: [
        {
          from: FROM,
          to: ERC20_ADDRESS,
          data: `0xa9059cbb${VAULT_EVM.slice(2).toLowerCase().padStart(64, '0')}${(1_000_000).toString(16).padStart(64, '0')}`,
        },
        'latest',
      ],
    });
    const reverts = rpc(() => ({
      error: { code: 3, message: 'execution reverted: ERC20: transfer amount exceeds balance' },
    }));
    expect(await reverts.reader.estimateTransferGas(ERC20_ADDRESS, FROM, VAULT_EVM, 1n)).toBe('reverts');
    const down = rpc(() => new Response('bad gateway', { status: 502 }));
    await expect(down.reader.estimateTransferGas(ERC20_ADDRESS, FROM, VAULT_EVM, 1n)).rejects.toThrow(
      /eth_estimateGas/,
    );
    const limited = rpc(() => ({ error: { code: -32005, message: 'rate limited' } }));
    await expect(limited.reader.estimateTransferGas(ERC20_ADDRESS, FROM, VAULT_EVM, 1n)).rejects.toThrow(
      /rate limited/,
    );
  });

  it('transfersFrom: Transfer logs out of the address, in chunks from the given block to the latest', async () => {
    const latest = 11_810_120n;
    const from = latest - LOG_CHUNK_BLOCKS - 10n;
    const { reader, seen } = rpc((q) => {
      if (q.method === 'eth_blockNumber') return { result: `0x${latest.toString(16)}` };
      const f = q.params[0] as { fromBlock: string; toBlock: string; topics: string[]; address: string };
      expect(f.address).toBe(ERC20_ADDRESS);
      expect(f.topics).toEqual([ERC20_TRANSFER_TOPIC, `0x${FROM.slice(2).toLowerCase().padStart(64, '0')}`]);
      if (BigInt(f.fromBlock) !== from) return { result: [] };
      return {
        result: [
          {
            transactionHash: '0x8669bd61b34db7b454db304f74c87426967d8e9a30de2e5227386f5bf097b25f',
            blockNumber: '0xb4352f',
            data: '0x00000000000000000000000000000000000000000000000000000000000f4240',
            topics: [
              ERC20_TRANSFER_TOPIC,
              `0x${FROM.slice(2).toLowerCase().padStart(64, '0')}`,
              `0x${VAULT_EVM.slice(2).toLowerCase().padStart(64, '0')}`,
            ],
          },
          { transactionHash: '0x01', blockNumber: '0x1', data: '0x01', topics: [ERC20_TRANSFER_TOPIC], removed: false },
          { transactionHash: '0x02', blockNumber: '0x1', data: '0x01', topics: ['0xdead', 'a', 'b'] },
        ],
      };
    });
    expect(await reader.transfersFrom(ERC20_ADDRESS, FROM, from)).toEqual([
      {
        txHash: '0x8669bd61b34db7b454db304f74c87426967d8e9a30de2e5227386f5bf097b25f',
        to: VAULT_EVM.toLowerCase(),
        amount: 1_000_000n,
        block: 11_810_095n,
      },
    ]);
    const ranges = seen
      .filter((q) => q.method === 'eth_getLogs')
      .map((q) => q.params[0] as { fromBlock: string; toBlock: string })
      .map((r) => [BigInt(r.fromBlock), BigInt(r.toBlock)]);
    expect(ranges).toEqual([
      [from, from + LOG_CHUNK_BLOCKS - 1n],
      [from + LOG_CHUNK_BLOCKS, latest],
    ]);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

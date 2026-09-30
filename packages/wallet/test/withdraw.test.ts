import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_EVM_GAS, STAGENET, bytesToHex } from '@evm-midnight-transparent/core';

import {
  WithdrawError,
  assertWithdrawShape,
  buildWithdraw,
  contractCalls,
  dustSpendCount,
  erasedHex,
  finalizeWithdraw,
  jsonRpcRequest,
  parseWithdrawParams,
  provenFromHex,
  readVaultEvmNonce,
  shieldedImbalances,
  txToHex,
  unprovenFromHex,
  type WithdrawDraft,
} from '../src/index.js';
import { internalsOf } from '../src/temp-wallet.js';

import {
  TEST_SEED_A,
  WSTKA,
  WUSDC,
  fixture,
  fixtureReader,
  fixtureText,
  walletWithCoins,
  type VaultFixture,
} from './helpers.js';

// G-BRIDGE B.3.1, replayed offline (fixtures/README.md): the vault's state recorded at stagenet block
// 679,357 (the latest block when the gate built its startWithdraw at 21:27:40 UTC), and the gate's
// arguments. The live call created request 21d8b43d…2900 with vault request nonce 27; building on the
// same state with the same arguments must create the same request.
const VAULT_AT_679357 = fixture<VaultFixture>('stagenet-vault-679357.json');
const B31 = {
  evmNonce: 9n,
  dest: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
  amount: 1_000_000n,
  requestId: '21d8b43db31bc94cc782eb460fc5cf2cf260fbeffe44938606f6b75660822900',
  requestNonce: 27n,
};
const STKA_ERC20 = '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52';
const VAULT = STAGENET.bridge.vaultAddress;
const SINGLETON = STAGENET.bridge.signetSingleton;

describe('buildWithdraw: the temporary wallet builds startWithdraw on the vault state', () => {
  it("reproduces G-BRIDGE's live request id from the recorded state and the same arguments", async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: B31.amount }]);
    const reader = fixtureReader(VAULT_AT_679357);
    const draft = await buildWithdraw(
      wallet,
      { colour: WSTKA, amount: B31.amount, dest: B31.dest, evmNonce: B31.evmNonce },
      { reader },
    );
    expect(draft.requestId).toBe(B31.requestId);
    expect(draft.requestNonce).toBe(B31.requestNonce);
    expect(draft).toMatchObject({
      colour: WSTKA,
      amount: B31.amount,
      erc20: STKA_ERC20,
      dest: B31.dest,
      evmNonce: B31.evmNonce,
      gas: DEFAULT_EVM_GAS,
      block: { hash: VAULT_AT_679357.block.hash, height: 679_357 },
      vault: VAULT,
      singleton: SINGLETON,
    });
    expect(draft.coinNonce).toMatch(/^[0-9a-f]{64}$/);
    // One block for everything: the vault's state and Zswap tree, then the callee's state.
    expect(reader.calls).toEqual(['block', `zswap+contract:${VAULT}`, `contract:${SINGLETON}`]);
    await draft.release();
    await wallet.close();
  });

  it('is unproven, balanced on its shielded side by the wallet alone, with no DUST, and holds the two calls', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: B31.amount }]);
    const draft = await buildWithdraw(
      wallet,
      { colour: WSTKA, amount: B31.amount, dest: B31.dest, evmNonce: B31.evmNonce },
      { reader: fixtureReader(VAULT_AT_679357) },
    );
    const tx = unprovenFromHex(draft.tx);
    expect(txToHex(tx)).toBe(draft.tx);
    expect(
      contractCalls(tx)
        .map((c) => [c.address, c.entryPoint])
        .sort(),
    ).toEqual(
      [
        [VAULT, 'startWithdraw'],
        [SINGLETON, 'signBidirectional'],
      ].sort(),
    );
    expect(Object.values(shieldedImbalances(tx)).every((v) => v === 0n)).toBe(true);
    expect(dustSpendCount(tx)).toBe(0);
    expect(() => assertWithdrawShape(tx, VAULT, SINGLETON)).not.toThrow();
    // The coin is booked until the withdrawal is released or lands.
    expect((await wallet.balances())[WSTKA] ?? 0n).toBe(0n);
    await draft.release();
    expect((await wallet.balances())[WSTKA]).toBe(B31.amount);
    await wallet.close();
  });

  it("takes the sponsor's withdraw-params as they come", async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: B31.amount }]);
    const params = parseWithdrawParams(
      {
        kind: 'swap',
        colour: WSTKA,
        amount: '1000000',
        erc20Address: STKA_ERC20,
        dest: B31.dest,
        refundRecipient: { left: wallet.coinPk },
        gas: { gasLimit: '100000', maxFeePerGas: '10000000000', maxPriorityFeePerGas: '1000000000', keyVersion: '1' },
        evmNonce: '9',
      },
      'swap',
    );
    const draft = await buildWithdraw(wallet, params, { reader: fixtureReader(VAULT_AT_679357) });
    expect(draft.requestId).toBe(B31.requestId);
    await draft.release();
    await wallet.close();
  });

  it('keeps the change when it withdraws part of a coin', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: 5_000_000n }]);
    const draft = await buildWithdraw(
      wallet,
      { colour: WSTKA, amount: B31.amount, dest: B31.dest, evmNonce: 10n },
      { reader: fixtureReader(VAULT_AT_679357) },
    );
    expect(draft.requestId).not.toBe(B31.requestId); // another nonce: another request
    expect(draft.requestNonce).toBe(B31.requestNonce);
    await draft.release();
    await wallet.close();
  });

  it('refuses what is not a withdrawal of a vault token the wallet holds, before reading the chain', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: B31.amount }]);
    const reader = fixtureReader(VAULT_AT_679357);
    const base = { colour: WSTKA, amount: B31.amount, dest: B31.dest, evmNonce: B31.evmNonce };
    const cases: [Partial<typeof base>, string][] = [
      [{ colour: 'ab'.repeat(32) }, 'unknown-token'],
      [{ colour: WUSDC }, 'insufficient-funds'],
      [{ amount: B31.amount + 1n }, 'insufficient-funds'],
      [{ amount: 0n }, 'bad-input'],
      [{ dest: '0x1234' }, 'bad-input'],
      [{ dest: `0x${'0'.repeat(40)}` }, 'bad-input'],
      [{ evmNonce: -1n }, 'bad-input'],
      [{ erc20Address: '0x0000000000000000000000000000000000000001' } as never, 'bad-input'],
      [{ refundRecipient: 'ab'.repeat(32) } as never, 'bad-input'],
    ];
    for (const [change, code] of cases) {
      await expect(buildWithdraw(wallet, { ...base, ...change }, { reader }), code).rejects.toMatchObject({ code });
    }
    expect(reader.calls).toEqual([]);
    expect((await wallet.balances())[WSTKA]).toBe(B31.amount);
    await wallet.close();
  });

  it('stops when the indexer has no vault state', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: B31.amount }]);
    const reader = { ...fixtureReader(VAULT_AT_679357), queryZSwapAndContractState: async () => null };
    await expect(
      buildWithdraw(wallet, { colour: WSTKA, amount: B31.amount, dest: B31.dest, evmNonce: 9n }, { reader }),
    ).rejects.toMatchObject({ code: 'no-vault-state' });
    await wallet.close();
  });
});

describe('finalizeWithdraw and the shape check', () => {
  // G-BRIDGE's own proven, bound startWithdraw (the temporary wallet's half, before the sponsor added
  // DUST; landed merged at block 679,385).
  const LIVE = fixtureText('g-bridge-startwithdraw-proven.hex');

  it('accepts the live proven startWithdraw as a withdrawal: two calls, balanced, no DUST', () => {
    const { tx, wasBound } = provenFromHex(LIVE);
    expect(wasBound).toBe(true);
    expect(() => assertWithdrawShape(tx, VAULT, SINGLETON)).not.toThrow();
    expect(tx.identifiers().map(String)).toContain(
      '000ee2e40e9571191cc12595bf5577d36354435c11bd28fb50095954b6a14d960d',
    );
  });

  it('refuses it for another draft: the identifiers differ', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: B31.amount }]);
    const draft = await buildWithdraw(
      wallet,
      { colour: WSTKA, amount: B31.amount, dest: B31.dest, evmNonce: B31.evmNonce },
      { reader: fixtureReader(VAULT_AT_679357) },
    );
    expect(() => finalizeWithdraw(draft, LIVE)).toThrow(expect.objectContaining({ code: 'proof-mismatch' }));
    expect(() => finalizeWithdraw(draft, draft.tx)).toThrow(/not a proven/);
    await draft.release();
    expect(() => finalizeWithdraw(draft, LIVE)).toThrow(expect.objectContaining({ code: 'released' }));
    await wallet.close();
  });

  // A draft for the live transaction (its unproven form was not recorded): what `buildWithdraw` keeps
  // for the finalizer, taken from the live transaction itself.
  const liveDraft = (): WithdrawDraft => {
    const { tx } = provenFromHex(LIVE);
    return {
      released: false,
      vault: VAULT,
      singleton: SINGLETON,
      requestId: B31.requestId,
      identifiers: tx.identifiers().map(String),
      erased: bytesToHex(tx.eraseProofs().serialize()),
    } as unknown as WithdrawDraft;
  };

  it('erases proofs and binding only: a draft and its proven form erase to the same bytes', () => {
    const { tx } = provenFromHex(LIVE);
    expect(erasedHex(tx)).toBe(liveDraft().erased);
  });

  it('accepts the proven transaction of its own draft (P4.2-fix C10)', () => {
    expect(finalizeWithdraw(liveDraft(), LIVE).requestId).toBe(B31.requestId);
  });

  it('refuses a proven answer that adds a separately balanced transfer, though every identifier and colour check passes (P4.2-fix C10, F-B9)', async () => {
    const other = await walletWithCoins(TEST_SEED_A, [{ colour: WUSDC, value: 5_000_000n }]);
    const { opened, keys } = internalsOf(other);
    const self = (await firstValueFrom(opened.wallet.state)).address;
    const extra = await opened.wallet.transferTransaction(keys.shieldedSecretKeys, [
      { type: WUSDC, receiverAddress: self, amount: 1_000_000n },
    ]);
    const tampered = provenFromHex(LIVE).tx.merge(extra.mockProve());
    // The old checks all pass: the two calls, no DUST, balanced, and every identifier of the draft.
    expect(() => assertWithdrawShape(tampered, VAULT, SINGLETON)).not.toThrow();
    const ids = new Set(tampered.identifiers().map(String));
    expect(liveDraft().identifiers.every((id) => ids.has(id))).toBe(true);
    expect(() => finalizeWithdraw(liveDraft(), txToHex(tampered))).toThrow(
      expect.objectContaining({ code: 'proof-mismatch' }),
    );
    await other.close();
  });

  it('refuses a take, or any other transaction, as a withdrawal', () => {
    const { tx } = provenFromHex(LIVE);
    expect(() => assertWithdrawShape(tx, SINGLETON, VAULT)).toThrow(WithdrawError);
    expect(() => assertWithdrawShape(tx, 'ab'.repeat(32), SINGLETON)).toThrow(/expected the vault's startWithdraw/);
  });
});

describe("the vault EVM account's nonce", () => {
  it('reads the pending nonce through EIP-1193', async () => {
    const request = vi.fn(async () => '0x9');
    expect(await readVaultEvmNonce(request, STAGENET.bridge.vaultEvmAddress.toLowerCase())).toBe(9n);
    expect(request).toHaveBeenCalledWith({
      method: 'eth_getTransactionCount',
      params: [STAGENET.bridge.vaultEvmAddress, 'pending'],
    });
    await expect(readVaultEvmNonce(async () => null, STAGENET.bridge.vaultEvmAddress)).rejects.toBeInstanceOf(
      WithdrawError,
    );
  });

  it('speaks JSON-RPC over fetch', async () => {
    const f = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const req = JSON.parse(String(init!.body));
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: req.method === 'eth_getTransactionCount' ? '0x1f' : null,
        }),
      );
    });
    const request = jsonRpcRequest('https://rpc.example', f as unknown as typeof fetch);
    expect(await readVaultEvmNonce(request, STAGENET.bridge.vaultEvmAddress)).toBe(31n);
    const bad = jsonRpcRequest(
      'https://rpc.example',
      (async () => new Response(JSON.stringify({ error: { message: 'nope' } }))) as unknown as typeof fetch,
    );
    await expect(bad({ method: 'eth_chainId' })).rejects.toThrow(/nope/);
  });
});

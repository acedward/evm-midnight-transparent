// The bridge's gas policy and preflights (copied from MN Bank's bridge test, acedward/passport-evm-dapp
// @ 911647b, without its account-gated bodies): the preflights refuse exactly what the vault's own
// preflight refuses (plus the queue), and the coin and circuit names are the vault's.

import { describe, expect, it } from 'vitest';

import {
  CoinJsonSchema,
  DEFAULT_EVM_GAS,
  VAULT_CIRCUITS,
  depositPreflight,
  evmTxParamsJson,
  matchesGasPolicy,
  maxGasCostWei,
  queuedDepositPreflight,
  withdrawPreflight,
} from '../src/bridge.js';

describe('the vault surface', () => {
  it("names the vault's six circuits", () => {
    expect(VAULT_CIRCUITS).toEqual([
      'startDeposit',
      'completeDeposit',
      'abandonDeposit',
      'startWithdraw',
      'completeWithdraw',
      'refundWithdraw',
    ]);
  });

  it('a coin is a 32-byte nonce and colour and a decimal value, nothing else', () => {
    const coin = { nonce: 'ab'.repeat(32), color: 'cd'.repeat(32), value: '1000000' };
    expect(CoinJsonSchema.parse(coin)).toEqual(coin);
    expect(CoinJsonSchema.safeParse({ ...coin, value: '-1' }).success).toBe(false);
    expect(CoinJsonSchema.safeParse({ ...coin, mtIndex: '1' }).success).toBe(false);
  });
});

describe('the gas policy', () => {
  it('is AA 00037 / G-BRIDGE: 100,000 gas at 10 gwei, 1 gwei tip, key version 1 (0.001 ETH per sweep)', () => {
    expect(maxGasCostWei(DEFAULT_EVM_GAS)).toBe(1_000_000_000_000_000n);
    const signed = evmTxParamsJson(DEFAULT_EVM_GAS, 5n);
    expect(signed).toEqual({
      nonce: '5',
      gasLimit: '100000',
      maxFeePerGas: '10000000000',
      maxPriorityFeePerGas: '1000000000',
      keyVersion: '1',
    });
    expect(matchesGasPolicy(signed, DEFAULT_EVM_GAS)).toBe(true);
    expect(matchesGasPolicy({ ...signed, maxFeePerGas: '10000000001' }, DEFAULT_EVM_GAS)).toBe(false);
  });
});

describe('the preflights', () => {
  const gas = DEFAULT_EVM_GAS;
  const cost = maxGasCostWei(gas);

  it('with nothing queued, the deposit preflight IS the vault one', () => {
    for (const [erc20Balance, ethBalance] of [
      [1_000_000n, cost],
      [999_999n, cost],
      [1_000_000n, cost - 1n],
      [0n, 0n],
    ] as const) {
      const ours = queuedDepositPreflight({ erc20Balance, ethBalance, amount: 1_000_000n, gas, decimals: 6 });
      const upstream = depositPreflight({
        erc20Balance,
        amount: 1_000_000n,
        ethBalance,
        gasLimit: gas.gasLimit,
        maxFeePerGas: gas.maxFeePerGas,
        decimals: 6,
      });
      expect(ours).toEqual(upstream);
    }
    expect(queuedDepositPreflight({ erc20Balance: 0n, ethBalance: 0n, amount: 1n, gas, decimals: 6 }).problems).toEqual(
      [
        'the deposit address holds 0 of the ERC20 but the sweep moves 0.000001: fund it on the EVM chain first',
        'the deposit address holds 0 wei but the sweep may cost up to 1000000000000000 wei (gasLimit 100000 x maxFeePerGas 10000000000): send it gas ETH first',
      ],
    );
  });

  it('reserves the tokens and gas of requests queued ahead on the same address', () => {
    const base = { amount: 1_000_000n, gas, decimals: 6 };
    expect(queuedDepositPreflight({ ...base, erc20Balance: 2_000_000n, ethBalance: 2n * cost }).ok).toBe(true);
    expect(
      queuedDepositPreflight({
        ...base,
        erc20Balance: 2_000_000n,
        ethBalance: 2n * cost,
        aheadSameToken: 1_000_000n,
        aheadSweeps: 1,
      }).ok,
    ).toBe(true);
    const short = queuedDepositPreflight({
      ...base,
      erc20Balance: 1_500_000n,
      ethBalance: 2n * cost - 1n,
      aheadSameToken: 1_000_000n,
      aheadSweeps: 1,
    });
    expect(short.ok).toBe(false);
    expect(short.problems).toHaveLength(2);
  });

  it('the withdrawal preflight names a vault gas or token shortfall', () => {
    expect(withdrawPreflight({ vaultEthWei: cost, vaultErc20: 1n, amount: 1n, gas }).ok).toBe(true);
    const r = withdrawPreflight({ vaultEthWei: cost - 1n, vaultErc20: 0n, amount: 1n, gas });
    expect(r.ok).toBe(false);
    expect(r.problems[0]).toMatch(/vault's Sepolia account holds 999999999999999 wei of gas/);
    expect(r.problems[1]).toMatch(/holds 0 of this token, less than the 1 to pay out/);
  });
});

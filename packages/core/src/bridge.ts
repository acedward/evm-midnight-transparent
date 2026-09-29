// The bridge's wire types and preflights, shared by the web app and the sponsor.
//
// Copied from MN Bank (acedward/passport-evm-dapp @ 911647b, packages/core/src/bridge.ts) without
// its account-gated bodies: here the vault is called directly (spec, Research "Bridge"):
//
//   deposit   the user's EVM wallet sends exactly the ERC20 amount, plus the sweep's gas ETH, to
//             the swap's deposit address (derived offline from the temporary wallet's coin
//             public key) -> `startDeposit` (permissionless; the sponsor submits it) -> the MPC
//             signs the sweep, it is broadcast, Sepolia finality, the MPC attests ->
//             `completeDeposit` (permissionless) mints the coin to the temporary wallet.
//   withdraw  `startWithdraw` spends the temporary wallet's coin (the browser proves it; the
//             sponsor adds the DUST) -> the MPC signs transfer(dest, amount) from the vault's own
//             EVM account, broadcast, finality, attestation -> `completeWithdraw` (nothing minted
//             on success; a refund on a transfer that returned false) or `refundWithdraw` (the
//             transfer never executed: the refund is always minted).
//
// The Ethereum transaction the MPC signs carries its nonce and gas. Every withdrawal shares the
// vault EVM account's single nonce, so withdrawals go through one lane (plan Q9).
//
// TODO(L-SPONSOR): the deposit and withdraw request bodies, the job results and the stage list
// the swap page shows; TODO(L-WALLET): the deposit-address derivation (vault `depositPath`).

import { z } from 'zod';

import { depositPreflight, type DepositPreflightResult } from './vendor/vault-preflight.js';

export { depositPreflight, type DepositPreflightResult };

const decimal = z.string().regex(/^[0-9]{1,40}$/);
const hex32 = z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/);

export const BRIDGE_KINDS = ['deposit', 'withdraw'] as const;
export type BridgeKind = (typeof BRIDGE_KINDS)[number];

/** The vault's circuits (`erc20-vault.compact`), as the bridge legs name them. */
export const VAULT_CIRCUITS = [
  'startDeposit',
  'completeDeposit',
  'abandonDeposit',
  'startWithdraw',
  'completeWithdraw',
  'refundWithdraw',
] as const;
export type VaultCircuit = (typeof VAULT_CIRCUITS)[number];

/** A shielded coin's public description, as JSON: hex strings and a decimal value. */
export const CoinJsonSchema = z.object({ nonce: hex32, color: hex32, value: decimal }).strict();
export type CoinJson = z.infer<typeof CoinJsonSchema>;

// ── The EVM transaction the MPC signs ─────────────────────────────────────────

/** The EIP-1559 fields of the transaction the MPC signs, as decimal strings. */
export const EvmTxParamsSchema = z
  .object({
    nonce: decimal,
    gasLimit: decimal,
    maxFeePerGas: decimal,
    maxPriorityFeePerGas: decimal,
    /** Selects the MPC root key; 1 today. */
    keyVersion: decimal,
  })
  .strict();
export type EvmTxParamsJson = z.infer<typeof EvmTxParamsSchema>;

export interface EvmGasPolicy {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  keyVersion: bigint;
}

/** AA 00037's proven values: 100,000 gas at 10 gwei (1 gwei tip). A swap's deposit sizes its own
 *  sweep gas tightly instead (spec Q5 A); a withdrawal is paid by the vault's EVM account. */
export const DEFAULT_EVM_GAS: Readonly<EvmGasPolicy> = Object.freeze({
  gasLimit: 100_000n,
  maxFeePerGas: 10_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  keyVersion: 1n,
});

/** The most the MPC-signed transaction can cost its sender: gasLimit × maxFeePerGas. */
export const maxGasCostWei = (g: Pick<EvmGasPolicy, 'gasLimit' | 'maxFeePerGas'>): bigint =>
  g.gasLimit * g.maxFeePerGas;

export function evmTxParamsJson(gas: EvmGasPolicy, nonce: bigint): EvmTxParamsJson {
  return {
    nonce: nonce.toString(10),
    gasLimit: gas.gasLimit.toString(10),
    maxFeePerGas: gas.maxFeePerGas.toString(10),
    maxPriorityFeePerGas: gas.maxPriorityFeePerGas.toString(10),
    keyVersion: gas.keyVersion.toString(10),
  };
}

/** True when the signed gas fields are exactly the policy's (the nonce is checked separately). */
export function matchesGasPolicy(evm: EvmTxParamsJson, gas: EvmGasPolicy): boolean {
  return (
    BigInt(evm.gasLimit) === gas.gasLimit &&
    BigInt(evm.maxFeePerGas) === gas.maxFeePerGas &&
    BigInt(evm.maxPriorityFeePerGas) === gas.maxPriorityFeePerGas &&
    BigInt(evm.keyVersion) === gas.keyVersion
  );
}

// ── Outcomes ──────────────────────────────────────────────────────────────────

/** What the MPC attested about the Sepolia transaction. */
export type AttestedKind = 'success' | 'returned-false' | 'never-executed';

/** Error codes a bridge job fails with (shown to the user with their message). */
export const BRIDGE_ERRORS = {
  preflight: 'preflight-refused',
  staleNonce: 'stale-evm-nonce',
  openRequest: 'request-still-open',
  gasPolicy: 'gas-policy',
  unknownToken: 'unknown-token',
  mpcTimeout: 'mpc-timeout',
  attestationTimeout: 'attestation-timeout',
  requestMatch: 'request-match',
  notOpen: 'request-not-open',
  inProgress: 'already-in-progress',
} as const;

// ── Preflights ────────────────────────────────────────────────────────────────

/**
 * The deposit preflight with requests already queued on the same deposit address: each queued
 * sweep will move its own amount of its own token and may cost its own gas, so this request only
 * passes when the address holds enough for every earlier one AND this one. With nothing queued it
 * is exactly the vault's preflight (`depositPreflight`). A swap's deposit address is used once,
 * so a swap normally has nothing queued.
 */
export function queuedDepositPreflight(input: {
  erc20Balance: bigint;
  ethBalance: bigint;
  amount: bigint;
  gas: Pick<EvmGasPolicy, 'gasLimit' | 'maxFeePerGas'>;
  decimals?: number;
  /** Earlier sweeps of the SAME token from this address that have not happened yet. */
  aheadSameToken?: bigint;
  /** How many earlier sweeps (any token) have not been broadcast yet. */
  aheadSweeps?: number;
}): DepositPreflightResult {
  const ahead = input.aheadSameToken ?? 0n;
  const sweeps = BigInt(input.aheadSweeps ?? 0);
  const perSweep = maxGasCostWei(input.gas);
  return depositPreflight({
    erc20Balance: input.erc20Balance > ahead ? input.erc20Balance - ahead : 0n,
    amount: input.amount,
    ethBalance: input.ethBalance > perSweep * sweeps ? input.ethBalance - perSweep * sweeps : 0n,
    gasLimit: input.gas.gasLimit,
    maxFeePerGas: input.gas.maxFeePerGas,
    ...(input.decimals === undefined ? {} : { decimals: input.decimals }),
  });
}

export interface WithdrawPreflightResult {
  ok: boolean;
  problems: string[];
  maxGasCostWei: bigint;
}

/**
 * Before a withdrawal starts: the vault's EVM account must hold the gas the transfer may cost,
 * and the ERC20 it will pay out.
 */
export function withdrawPreflight(input: {
  vaultEthWei: bigint;
  vaultErc20: bigint | null;
  amount: bigint;
  gas: Pick<EvmGasPolicy, 'gasLimit' | 'maxFeePerGas'>;
}): WithdrawPreflightResult {
  const cost = maxGasCostWei(input.gas);
  const problems: string[] = [];
  if (input.amount <= 0n) problems.push('the amount must be positive');
  if (input.vaultEthWei < cost) {
    problems.push(
      `the vault's Sepolia account holds ${input.vaultEthWei.toString()} wei of gas but the transfer may cost up to ${cost.toString()} wei; it must be topped up first`,
    );
  }
  if (input.vaultErc20 !== null && input.vaultErc20 < input.amount) {
    problems.push(
      `the vault's Sepolia account holds ${input.vaultErc20.toString()} of this token, less than the ${input.amount.toString()} to pay out`,
    );
  }
  return { ok: problems.length === 0, problems, maxGasCostWei: cost };
}

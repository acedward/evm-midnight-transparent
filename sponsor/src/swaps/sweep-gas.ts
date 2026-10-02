// The deposit sweep's Sepolia gas, sized per token (spec Q5 A: the user sends it with the token, and
// what the sweep does not burn stays at the deposit address for good, so it is sized tightly).
//
// The vault's `startDeposit` fixes the EIP-1559 fields of the transaction the MPC signs, and the vault
// preflight (and the node) require the deposit address to hold `gasLimit × maxFeePerGas` of ETH. The
// G-BRIDGE gate's formula (plan B.4, proven live 2026-09-29):
//
//   maxPriorityFeePerGas = 0.5 gwei
//   maxFeePerGas         = ceil to 0.1 gwei (2 × latest baseFee + tip)
//   ethWei               = gasLimit × maxFeePerGas
//
// THE GAS LIMIT PER TOKEN. A sweep is one ERC20 `transfer(vaultEvm, amount)` from the deposit address.
// Its cost depends on the token's code and on whether the vault account's balance slot is empty
// (a fresh slot costs 20k gas more); the EVM refund for emptying the sender's slot comes only after
// execution, so the limit must cover the pre-refund cost. Measured on Sepolia:
//   - OpenZeppelin ERC20 (stkA/B/C; TBILL and TB13W/26W/52W are the same `transfer`): 51,577 gas into an
//     empty holder (G-BRIDGE B.2.1), 34,477 into a funded one (B.3.3); the G-BRIDGE sweep used 29,677
//     (after its refund); AA 00037's first stk sweeps up to 46,777.
//   - Circle's USDC (FiatToken proxy): 45,059 gas into an empty holder (AA 00037).
// Every token gets 65,000 (the G-BRIDGE value, 26% above the worst measurement), overridable per
// symbol with SWEEP_GAS_LIMITS=USDC:70000,stkA:60000 when a token's measurements say otherwise.

export const SWEEP_TIP_WEI = 500_000_000n; // 0.5 gwei
const TENTH_GWEI = 100_000_000n;

/** The worst measured sweep-equivalent transfer per token, for the margin test. */
export const MEASURED_WORST_GAS: Readonly<Record<string, bigint>> = {
  stkA: 51_577n,
  stkB: 51_577n,
  stkC: 51_577n,
  TBILL: 51_577n,
  TB13W: 51_577n,
  TB26W: 51_577n,
  TB52W: 51_577n,
  USDC: 45_059n,
};

export const DEFAULT_SWEEP_GAS_LIMIT = 65_000n;

export const DEFAULT_SWEEP_GAS_LIMITS: Readonly<Record<string, bigint>> = Object.fromEntries(
  Object.keys(MEASURED_WORST_GAS).map((s) => [s, DEFAULT_SWEEP_GAS_LIMIT]),
);

/** `SWEEP_GAS_LIMITS` ("USDC:70000,stkA:60000") over the defaults. Refuses nonsense. */
export function parseSweepGasLimits(text: string | undefined): Record<string, bigint> {
  const out: Record<string, bigint> = { ...DEFAULT_SWEEP_GAS_LIMITS };
  if (!text || text.trim() === '') return out;
  for (const part of text.split(',')) {
    const m = /^\s*([A-Za-z0-9]{1,16})\s*:\s*(\d{5,7})\s*$/.exec(part);
    if (!m) throw new Error(`SWEEP_GAS_LIMITS: "${part.trim()}" is not SYMBOL:GAS`);
    const gas = BigInt(m[2]!);
    if (gas < 21_000n || gas > 500_000n) throw new Error(`SWEEP_GAS_LIMITS: ${m[1]} gas ${gas} out of range`);
    out[m[1]!] = gas;
  }
  return out;
}

export interface SweepGasSizing {
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  ethWei: bigint;
}

/** The sweep fields for `symbol` at the latest base fee. */
export function sizeSweepGas(
  symbol: string,
  baseFeePerGas: bigint,
  limits: Readonly<Record<string, bigint>> = DEFAULT_SWEEP_GAS_LIMITS,
): SweepGasSizing {
  if (baseFeePerGas < 0n) throw new Error('negative base fee');
  const gasLimit = limits[symbol] ?? DEFAULT_SWEEP_GAS_LIMIT;
  const raw = 2n * baseFeePerGas + SWEEP_TIP_WEI;
  const maxFeePerGas = ((raw + TENTH_GWEI - 1n) / TENTH_GWEI) * TENTH_GWEI;
  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas: SWEEP_TIP_WEI, ethWei: gasLimit * maxFeePerGas };
}

// @evm-midnight-transparent/wallet: the swap's temporary Midnight wallet (browser-safe).
//
// The lane contract (plan "Lane contracts", the wallet module):
//   ensureBufferGlobal()                                  once at app start
//   deriveSwapSeed(signer, salt) → {seed, deterministic}  "start swap" signed twice (Q4)
//   createTempWallet(seed) → TempWallet                   shielded-only sync; public keys, addresses
//   swapDepositAddress / depositAddressFor                (core) the swap's Sepolia deposit address
//   buildTake → sponsor.prove('take') → finalizeTake → submitTake          the take, via the batcher
//   readVaultEvmNonce → buildWithdraw → sponsor.prove('withdraw') → finalizeWithdraw → sponsor.withdraw
// The key stays in this package's memory (temp-wallet.ts); `wallet.close()` wipes it.

export * from './browser.js';
export * from './keys.js';
export * from './outputs.js';
export * from './prover.js';
export * from './shielded.js';
export * from './sponsor-client.js';
export * from './take.js';
export {
  createTempWallet,
  deriveSwapSeed,
  eip1193SwapSigner,
  TempWalletError,
  type CreateTempWalletOptions,
  type Eip1193Request,
  type SwapSeed,
  type SwapSigner,
  type TempWallet,
  type WalletCoin,
} from './temp-wallet.js';
export * from './tx.js';
export * from './withdraw.js';

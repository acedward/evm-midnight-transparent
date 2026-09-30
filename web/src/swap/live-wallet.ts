// The real wallet module (`@evm-midnight-transparent/wallet`, L-WALLET) as the page's port
// (./ports.ts), with the network profile bound. Only its TYPES are imported here, so this file adds
// nothing to the first bundle and the compiler checks that the real module fits the port the pages
// and the mocks use. ./wiring.ts (`lazyWalletModule`) loads the module on first use, calls
// `ensureBufferGlobal()`, and hands it to `adaptWalletModule(w, network)`.

import { type NetworkProfile, swapDepositAddress } from '@evm-midnight-transparent/core';
import type * as Wallet from '@evm-midnight-transparent/wallet';

import type { TakeDraft, TempWallet, WalletModule, WithdrawDraft } from './ports.js';

export function adaptWalletModule(w: typeof Wallet, profile: NetworkProfile): WalletModule {
  // Every TempWallet and draft the page hands back came from this module: the casts only restore
  // the fuller types the port hides.
  const real = (t: TempWallet) => t as Wallet.TempWallet;
  return {
    kind: 'live',
    async deriveSwapSeed(signer, salt) {
      const r = await w.deriveSwapSeed(
        { address: signer.address, signTypedData: (td) => signer.signTypedData(td) },
        salt,
        { profile },
      );
      return { seed: r.seed, deterministic: r.deterministic };
    },
    createTempWallet: (seed) => w.createTempWallet(seed, { profile }),
    depositAddressFor: (coinPk) => swapDepositAddress(profile, coinPk),
    buildTake: (wallet, offerBech32) => w.buildTake(real(wallet), offerBech32),
    finalizeTake: (draft: TakeDraft, provenHex) => w.finalizeTake(draft as Wallet.TakeDraft, provenHex),
    submitTake: (wallet, settlement) => w.submitTake(real(wallet), settlement.tx),
    buildWithdraw: (wallet, params) => w.buildWithdraw(real(wallet), params),
    finalizeWithdraw: (draft: WithdrawDraft, provenHex) => w.finalizeWithdraw(draft as Wallet.WithdrawDraft, provenHex),
  };
}

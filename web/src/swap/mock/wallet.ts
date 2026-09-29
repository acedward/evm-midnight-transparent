// The mock wallet module: the wallet module's contract (./ports.ts, as `@evm-midnight-transparent/wallet`
// is built: drafts, `/prove`, finalize, submit) on the mock chain.
//
// Real: `deriveSwapSeed` (core swap-key.ts: the EIP-712 "start swap" message signed twice, seed =
// keccak256 of the first signature), so the determinism and resume checks run for real against the
// test wallet; and the deposit address (core's `swapDepositAddress`, the vault's derivation). Mock:
// the "keys" are hashes of the seed, the transactions are tagged JSON (./tx.ts), the chain is
// ./chain.ts. Like the real module, a draft books its coin until it is released or finalized, so a
// second build while one is outstanding is refused.

import {
  type NetworkProfile,
  deriveSwapSeed as coreDeriveSwapSeed,
  formatShieldedAddress,
  swapDepositAddress,
} from '@evm-midnight-transparent/core';
import { getAddress, keccak256, toUtf8Bytes } from 'ethers';

import type {
  SubmitTakeResult,
  TakeDraft,
  TempWallet,
  TypedDataSigner,
  WalletModule,
  WithdrawDraft,
  WithdrawParams,
} from '../ports.js';
import { MockChain, MockChainError } from './chain.js';
import { decodeMockTx, encodeMockTx } from './tx.js';

const h = (label: string) => keccak256(toUtf8Bytes(label)).slice(2);
const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');

export interface MockWalletOptions {
  profile: NetworkProfile;
  /** How long a sync takes, in ms. */
  syncMs: () => number;
}

/** Counts of what the mock wallet module did, for the specs (no secret). */
export interface MockWalletStats {
  drafts: number;
  released: number;
}

export function mockWalletModule(
  chain: MockChain,
  options: MockWalletOptions,
): WalletModule & { stats: MockWalletStats } {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const { profile } = options;
  const stats: MockWalletStats = { drafts: 0, released: 0 };
  /** Wallets with a draft that is neither released nor finalized. */
  const booked = new Set<string>();

  const draftFor = (coinPk: string, id: string) => {
    stats.drafts++;
    booked.add(coinPk);
    let released = false;
    return {
      id,
      async release() {
        if (released) return;
        released = true;
        stats.released++;
        booked.delete(coinPk);
      },
      get released() {
        return released;
      },
    };
  };

  return {
    kind: 'mock',
    stats,

    async deriveSwapSeed(signer: TypedDataSigner, salt: string) {
      const r = await coreDeriveSwapSeed(
        (td) => signer.signTypedData(td),
        { network: profile.midnightNetworkId, vault: profile.bridge.vaultAddress, salt, chainId: profile.evm.chainId },
        signer.address,
      );
      return { seed: r.seedHex, deterministic: r.deterministic };
    },

    async createTempWallet(seed: string): Promise<TempWallet> {
      if (!/^[0-9a-f]{64}$/.test(seed)) throw new MockChainError('the seed must be 64 hex');
      const coinPk = h(`emt-mock-coin-pk:${seed}`);
      const encPk = h(`emt-mock-enc-pk:${seed}`);
      let synced: Record<string, bigint> = {};
      return {
        coinPk,
        encPk,
        shieldedAddress: formatShieldedAddress({ coinPublicKey: coinPk, encryptionPublicKey: encPk }, profile.name),
        async sync() {
          await sleep(options.syncMs());
          synced = Object.fromEntries(chain.balances(coinPk));
          return { ms: options.syncMs() };
        },
        async balances() {
          return { ...synced };
        },
        async close() {
          synced = {};
        },
      };
    },

    depositAddressFor: (coinPk) => swapDepositAddress(profile, coinPk),

    async buildTake(wallet: TempWallet, offerBech32: string): Promise<TakeDraft> {
      const offerId = MockChain.offerIdOfBech32(offerBech32);
      const offer = offerId ? chain.offer(offerId) : undefined;
      if (!offerId || !offer) throw new MockChainError('not a mock offer');
      if (booked.has(wallet.coinPk)) throw new MockChainError('a coin is booked by another draft');
      const want = offer.wants[0]!;
      if ((chain.balances(wallet.coinPk).get(want.token) ?? 0n) < want.amount)
        throw new MockChainError('insufficient-funds: the temporary wallet does not hold what the offer wants');
      const d = draftFor(wallet.coinPk, randomHex());
      return Object.assign(d, { tx: encodeMockTx({ kind: 'take', coinPk: wallet.coinPk, offerId, draft: d.id }) });
    },

    finalizeTake(draft: TakeDraft, provenHex: string) {
      const d = draft as TakeDraft & { id: string; released: boolean };
      const tx = decodeMockTx(provenHex);
      if (d.released) throw new MockChainError('this take was released; build it again');
      if (!tx?.proven || tx.kind !== 'take' || tx.draft !== d.id)
        throw new MockChainError('the proven transaction is not this take');
      booked.delete(tx.coinPk);
      return { tx: encodeMockTx({ ...tx, merged: true }) };
    },

    async submitTake(wallet: TempWallet, settlement: { tx: string }): Promise<SubmitTakeResult> {
      const tx = decodeMockTx(settlement.tx);
      if (!tx || tx.kind !== 'take' || !tx.merged || !tx.offerId || tx.coinPk !== wallet.coinPk)
        throw new MockChainError('not a finalized mock take of this wallet');
      const offer = chain.offer(tx.offerId);
      const base = { httpStatus: 200, inputChars: settlement.tx.length };
      if (!offer || offer.status !== 'live') {
        return {
          ...base,
          ok: false,
          lostRace: true,
          body: { success: false, error: '239 NullifierAlreadyPresent' },
          error: '239 NullifierAlreadyPresent',
        };
      }
      const want = offer.wants[0]!;
      const give = offer.gives[0]!;
      chain.burn(tx.coinPk, want.token, want.amount);
      chain.mint(tx.coinPk, give.token, give.amount);
      const transactionHash = chain.newHash('take');
      chain.recordTake(tx.coinPk, transactionHash);
      chain.consume(offer.offerId);
      return { ...base, ok: true, lostRace: false, transactionHash, body: { success: true, transactionHash } };
    },

    async buildWithdraw(wallet: TempWallet, p: WithdrawParams): Promise<WithdrawDraft> {
      if (booked.has(wallet.coinPk)) throw new MockChainError('a coin is booked by another draft');
      if (p.refundRecipient !== wallet.coinPk) throw new MockChainError('the refund recipient is not this wallet');
      if ((chain.balances(wallet.coinPk).get(p.colour) ?? 0n) < p.amount)
        throw new MockChainError('insufficient-funds: the temporary wallet does not hold that coin');
      const d = draftFor(wallet.coinPk, randomHex());
      const coinNonce = randomHex();
      return Object.assign(d, {
        coinNonce,
        evmNonce: p.evmNonce,
        tx: encodeMockTx({
          kind: 'withdraw',
          coinPk: wallet.coinPk,
          colour: p.colour,
          amount: p.amount.toString(),
          dest: getAddress(p.dest),
          coinNonce,
          evmNonce: p.evmNonce.toString(),
          draft: d.id,
        }),
      });
    },

    finalizeWithdraw(draft: WithdrawDraft, provenHex: string) {
      const d = draft as WithdrawDraft & { id: string; released: boolean };
      const tx = decodeMockTx(provenHex);
      if (d.released) throw new MockChainError('this withdrawal was released; build it again');
      if (!tx?.proven || tx.kind !== 'withdraw' || tx.draft !== d.id)
        throw new MockChainError('the proven transaction is not this withdrawal');
      booked.delete(tx.coinPk);
      return { tx: encodeMockTx({ ...tx, bound: true }) };
    },
  };
}

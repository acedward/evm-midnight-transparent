// The mock wallet module: the wallet module's contract (./ports.ts, as `@evm-midnight-transparent/wallet`
// is built: drafts, `/prove`, finalize, submit) on the mock chain.
//
// Real: `deriveSwapSeed` (core swap-key.ts: the EIP-712 "start swap" message signed twice, seed =
// keccak256 of the first signature), so the determinism and resume checks run for real against the
// test wallet; and the deposit address (core's `swapDepositAddress`, the vault's derivation). Mock:
// the "keys" are hashes of the seed, the transactions are tagged JSON (./tx.ts), the chain is
// ./chain.ts. Like the real module, a draft books its coin (the SDK's pending spend) until it is
// released or the chain spends it: finalizing a draft does NOT give the coin back, and the wallet's
// balances leave booked coins out (the real `balances` are the available coins only). So a
// withdrawal the sponsor accepted and whose start then failed keeps its coin booked until the page
// releases the draft, exactly as the real wallet does (P4.2-fix2 R3, the audit's F-B24: the mock
// once released at finalize, which hid that the page never released it).

import {
  type NetworkProfile,
  SWAP_KEY_DERIVATION_LATEST,
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

  /** Each wallet's state: its balances as of its last sync, and the coins its drafts booked (by
   *  draft id), as the real wallet's pending spends. */
  interface WalletState {
    synced: Record<string, bigint>;
    booked: Map<string, { colour: string; amount: bigint }>;
  }
  const states = new WeakMap<TempWallet, WalletState>();
  const stateOf = (w: TempWallet) => {
    const st = states.get(w);
    if (!st) throw new MockChainError('not a mock temporary wallet, or it is closed');
    return st;
  };
  const bookedOf = (st: WalletState, colour: string) =>
    [...st.booked.values()].filter((b) => b.colour === colour).reduce((a, b) => a + b.amount, 0n);
  /** What a new draft may spend of `colour`: the synced balance less the booked coins. */
  const available = (st: WalletState, colour: string) => (st.synced[colour] ?? 0n) - bookedOf(st, colour);

  const draftFor = (wallet: TempWallet, coin: { colour: string; amount: bigint }) => {
    const st = stateOf(wallet);
    if (bookedOf(st, coin.colour) > 0n && available(st, coin.colour) < coin.amount)
      throw new MockChainError('a coin is booked by another draft');
    if (available(st, coin.colour) < coin.amount)
      throw new MockChainError('insufficient-funds: the temporary wallet does not hold that coin');
    stats.drafts++;
    const id = randomHex();
    st.booked.set(id, coin);
    let released = false;
    return {
      id,
      async release() {
        if (released) return;
        released = true;
        stats.released++;
        st.booked.delete(id);
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
        {
          network: profile.midnightNetworkId,
          vault: profile.bridge.vaultAddress,
          salt,
          chainId: profile.evm.chainId,
          derivation: SWAP_KEY_DERIVATION_LATEST,
        },
        signer.address,
      );
      return { seed: r.seedHex, deterministic: r.deterministic };
    },

    async createTempWallet(seed: string): Promise<TempWallet> {
      if (!/^[0-9a-f]{64}$/.test(seed)) throw new MockChainError('the seed must be 64 hex');
      const coinPk = h(`emt-mock-coin-pk:${seed}`);
      const encPk = h(`emt-mock-enc-pk:${seed}`);
      const st: WalletState = { synced: {}, booked: new Map() };
      const wallet: TempWallet = {
        coinPk,
        encPk,
        shieldedAddress: formatShieldedAddress({ coinPublicKey: coinPk, encryptionPublicKey: encPk }, profile.name),
        async sync() {
          await sleep(options.syncMs());
          // A booked coin the chain has spent is no longer pending (the real wallet sees its nullifier).
          for (const id of [...st.booked.keys()]) if (chain.isSpent(id)) st.booked.delete(id);
          st.synced = Object.fromEntries(chain.balances(coinPk));
          return { ms: options.syncMs() };
        },
        async balances() {
          // The available coins: booked ones left out, as the SDK's `balances`.
          const out: Record<string, bigint> = {};
          for (const colour of Object.keys(st.synced)) {
            const v = available(st, colour);
            if (v > 0n) out[colour] = v;
          }
          return out;
        },
        async close() {
          st.synced = {};
          st.booked.clear();
        },
      };
      states.set(wallet, st);
      return wallet;
    },

    depositAddressFor: (coinPk) => swapDepositAddress(profile, coinPk),

    async buildTake(wallet: TempWallet, offerBech32: string): Promise<TakeDraft> {
      const offerId = MockChain.offerIdOfBech32(offerBech32);
      const offer = offerId ? chain.offer(offerId) : undefined;
      if (!offerId || !offer) throw new MockChainError('not a mock offer');
      const want = offer.wants[0]!;
      const d = draftFor(wallet, { colour: want.token, amount: want.amount });
      const give = offer.gives[0]!;
      // The received coin (mock coins are exact: no change), disclosed to `/prove` (P4.2-fix2 R1).
      const received = { nonce: randomHex(), colour: give.token, value: give.amount };
      // Like the real module: the id and the terms of the offer AS SERVED (P4.2-fix C10).
      return Object.assign(d, {
        offerId,
        terms: {
          give: [{ colour: want.token, amount: want.amount }],
          receive: [{ colour: give.token, amount: give.amount }],
        },
        walletOutputs: [received],
        tx: encodeMockTx({
          kind: 'take',
          coinPk: wallet.coinPk,
          offerId,
          draft: d.id,
          outputs: [{ ...received, value: received.value.toString() }],
        }),
      });
    },

    finalizeTake(draft: TakeDraft, provenHex: string) {
      const d = draft as TakeDraft & { id: string; released: boolean };
      const tx = decodeMockTx(provenHex);
      if (d.released) throw new MockChainError('this take was released; build it again');
      if (!tx?.proven || tx.kind !== 'take' || tx.draft !== d.id)
        throw new MockChainError('the proven transaction is not this take');
      // Like the real finalizer: it checks and merges; the coin stays booked until the take lands
      // (the chain spends it) or the page releases the draft.
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
      chain.markSpent(tx.draft);
      chain.mint(tx.coinPk, give.token, give.amount);
      const transactionHash = chain.newHash('take');
      chain.recordTake(tx.coinPk, transactionHash);
      chain.consume(offer.offerId);
      return { ...base, ok: true, lostRace: false, transactionHash, body: { success: true, transactionHash } };
    },

    async buildWithdraw(wallet: TempWallet, p: WithdrawParams): Promise<WithdrawDraft> {
      if (p.refundRecipient !== wallet.coinPk) throw new MockChainError('the refund recipient is not this wallet');
      const d = draftFor(wallet, { colour: p.colour, amount: p.amount });
      const coinNonce = randomHex();
      return Object.assign(d, {
        coinNonce,
        evmNonce: p.evmNonce,
        // A mock coin is exact: no change comes back (P4.2-fix2 R1).
        walletOutputs: [],
        tx: encodeMockTx({
          kind: 'withdraw',
          coinPk: wallet.coinPk,
          colour: p.colour,
          amount: p.amount.toString(),
          dest: getAddress(p.dest),
          coinNonce,
          evmNonce: p.evmNonce.toString(),
          draft: d.id,
          outputs: [],
        }),
      });
    },

    finalizeWithdraw(draft: WithdrawDraft, provenHex: string) {
      const d = draft as WithdrawDraft & { id: string; released: boolean };
      const tx = decodeMockTx(provenHex);
      if (d.released) throw new MockChainError('this withdrawal was released; build it again');
      if (!tx?.proven || tx.kind !== 'withdraw' || tx.draft !== d.id)
        throw new MockChainError('the proven transaction is not this withdrawal');
      // Like the real finalizer: it checks and binds; the coin stays booked until the sponsor's start
      // lands (the chain spends it) or the page releases the draft.
      return { tx: encodeMockTx({ ...tx, bound: true }) };
    },
  };
}

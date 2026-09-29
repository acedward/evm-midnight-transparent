// L-WALLET's headless-browser check: the wallet module, bundled by Vite with no plugins, in Chromium.
//
// The page exposes `window.walletRun(input)`; the driver (run.ts) calls it once. Everything runs in
// the page as it will in the app, READ-ONLY against stagenet: nothing is proven, nothing submitted.
//   1. `deriveSwapSeed` over an injected EIP-1193 wallet (`window.ethereum`, whose
//      `eth_signTypedData_v4` the driver answers with a PUBLIC test key), signed twice;
//   2. `createTempWallet` + `sync()`: the shielded-only sync from genesis, timed;
//   3. a LIVE offer from the kernel (both legs vault tokens): `buildTake` from the synced wallet
//      (empty: refused with insufficient-funds, before any coin is booked), then from a second wallet
//      whose shielded state holds exactly the wanted amount (test/restored-wallet.ts, local coins
//      that are not on chain): the unproven take, built, checked, released;
//   4. `buildWithdraw` on the vault's LIVE state (the indexer, the vendored vault JS, midnight-js,
//      all loaded lazily): the unproven startWithdraw of the offer's receive leg, built and released.
// It returns public numbers only; the seed stays in the page's memory.

import {
  KernelClient,
  STAGENET,
  deriveBook,
  newSwapSalt,
  registryFor,
  swapDepositAddress,
  timeToExpiryMs,
  type SwapOffer,
} from '@evm-midnight-transparent/core';

import {
  buildTake,
  buildWithdraw,
  contractCalls,
  createTempWallet,
  deriveSwapSeed,
  eip1193SwapSigner,
  ensureBufferGlobal,
  shieldedImbalances,
  unprovenFromHex,
  type Eip1193Request,
} from '../../src/index.js';
import { walletWithCoins } from '../restored-wallet.js';

ensureBufferGlobal();

interface RunInput {
  evmAddress: string;
  kernelUrl?: string;
}

const s1 = (ms: number) => Math.round(ms / 100) / 10;
const big = (v: bigint) => v.toString();

/** The first swappable live offer (core's book: one shielded vault token each way) with its bytes. */
async function liveOffer(kernelUrl: string): Promise<{ offer: SwapOffer; offerBech32: string; swappable: number }> {
  const kernel = new KernelClient({ baseUrl: kernelUrl });
  const page = await kernel.offersPage({ limit: 100 });
  const book = deriveBook(page.offers, registryFor('stagenet'));
  const now = Date.now();
  const offer = book.offers.find((o) => (timeToExpiryMs(o, now) ?? Infinity) > 5 * 60_000);
  if (!offer) throw new Error(`no swappable live offer among ${page.offers.length}`);
  const detail = await kernel.offer(offer.offerId);
  if (!detail) throw new Error('the kernel no longer has the offer');
  return { offer, offerBech32: detail.offerBech32, swappable: book.offers.length };
}

async function walletRun(input: RunInput): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { userAgent: navigator.userAgent, origin: location.origin };
  const ethereum = (window as unknown as { ethereum: { request: Eip1193Request } }).ethereum;

  // 1. The seed: "start swap" signed twice by the injected wallet.
  const salt = newSwapSalt();
  const t0 = performance.now();
  const { seed, deterministic, signer } = await deriveSwapSeed(eip1193SwapSigner(ethereum, input.evmAddress), salt);
  out.derive = { ms: Math.round(performance.now() - t0), deterministic, signer, salt };

  // 2. The temporary wallet, shielded-only, synced from genesis.
  const wallet = await createTempWallet(seed);
  let updates = 0;
  const sync = await wallet.sync(() => {
    updates += 1;
  });
  const progress: { appliedIndex?: number; latestIndex?: number } = {};
  wallet.onProgress((p) => Object.assign(progress, p))();
  out.wallet = {
    coinPk: wallet.coinPk,
    shieldedAddress: wallet.shieldedAddress,
    shieldedAddressChars: wallet.shieldedAddress.length,
    depositAddress: wallet.depositAddress,
    depositAddressMatchesCore: wallet.depositAddress === swapDepositAddress(STAGENET, wallet.coinPk),
    syncSeconds: s1(sync.ms),
    progressUpdates: updates,
    ...progress,
    balances: Object.fromEntries(Object.entries(await wallet.balances()).map(([c, v]) => [c, big(v)])),
  };

  // 3. A live offer, taken on paper.
  const kernelUrl = (input.kernelUrl ?? STAGENET.zswap.kernelUrl).replace(/\/+$/, '');
  const { offer, offerBech32, swappable } = await liveOffer(kernelUrl);
  out.offer = {
    offerId: offer.offerId,
    swappableLive: swappable,
    pay: { token: offer.pay.token.midnightName, amount: big(offer.pay.amount) },
    receive: { token: offer.receive.token.midnightName, amount: big(offer.receive.amount) },
    expiresAt: offer.expiresAt,
  };
  out.takeFromSyncedWallet = await buildTake(wallet, offerBech32).then(
    () => 'built',
    (e: unknown) => `${(e as { code?: string }).code ?? 'error'}: ${(e as Error).message}`,
  );

  const funded = await walletWithCoins(seed, [{ colour: offer.pay.token.midnightColour, value: offer.pay.amount }]);
  const t1 = performance.now();
  const draft = await buildTake(funded, offerBech32);
  const takeMs = performance.now() - t1;
  const takeTx = unprovenFromHex(draft.tx);
  out.take = {
    ms: Math.round(takeMs),
    offerIdMatches: draft.offerId === offer.offerId,
    termsMatchTheBook:
      draft.terms.give.length === 1 &&
      draft.terms.give[0]!.colour === offer.pay.token.midnightColour &&
      draft.terms.give[0]!.amount === offer.pay.amount &&
      draft.terms.receive[0]!.colour === offer.receive.token.midnightColour &&
      draft.terms.receive[0]!.amount === offer.receive.amount,
    unprovenBytes: draft.tx.length / 2,
    imbalances: Object.fromEntries(Object.entries(shieldedImbalances(takeTx)).map(([c, v]) => [c, big(v)])),
    identifiers: draft.identifiers.length,
  };
  await draft.release();
  await funded.close();

  // 4. The withdrawal of what the offer gives, on the vault's live state.
  const receiver = await walletWithCoins(seed, [
    { colour: offer.receive.token.midnightColour, value: offer.receive.amount },
  ]);
  const t2 = performance.now();
  const w = await buildWithdraw(receiver, {
    colour: offer.receive.token.midnightColour,
    amount: offer.receive.amount,
    dest: input.evmAddress,
    evmNonce: 0n,
  });
  const withdrawMs = performance.now() - t2;
  const wtx = unprovenFromHex(w.tx);
  out.withdraw = {
    msIncludingLazyLoad: Math.round(withdrawMs),
    block: w.block,
    requestId: w.requestId,
    requestNonce: big(w.requestNonce),
    erc20: w.erc20,
    calls: contractCalls(wtx).map((c) => `${c.address.slice(0, 8)}…:${c.entryPoint}`),
    balanced: Object.values(shieldedImbalances(wtx)).every((v) => v === 0n),
    unprovenBytes: w.tx.length / 2,
    coinNonceHex: /^[0-9a-f]{64}$/.test(w.coinNonce),
  };
  const t3 = performance.now();
  const again = await buildWithdraw(receiver, {
    colour: offer.receive.token.midnightColour,
    amount: offer.receive.amount,
    dest: input.evmAddress,
    evmNonce: 0n,
  }).catch((e: unknown) => e as Error);
  out.withdrawSecondBuild =
    again instanceof Error
      ? `${(again as { code?: string }).code}: ${again.message}`
      : { ms: Math.round(performance.now() - t3), note: 'the first draft still books the coin' };
  await w.release();
  await receiver.close();
  await wallet.close();
  out.closed = wallet.closed;
  return out;
}

(window as unknown as { walletRun: typeof walletRun }).walletRun = walletRun;
document.getElementById('status')!.textContent = 'ready';

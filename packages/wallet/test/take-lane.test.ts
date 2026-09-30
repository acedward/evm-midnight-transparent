import { firstValueFrom } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { MAX_INPUT_CHARS, decodeOffer, offerIdOf } from '@evm-midnight-transparent/core';

import {
  TakeError,
  buildTake,
  decodeMakerTransaction,
  dustSpendCount,
  finalizeTake,
  servedOfferId,
  shieldedImbalances,
  submitTake,
  txToHex,
  unprovenFromHex,
} from '../src/index.js';
import { internalsOf, type TempWallet } from '../src/temp-wallet.js';

import { TEST_SEED_A, TEST_SEED_B, WSTKA, WUSDC, fixture, walletWithCoins } from './helpers.js';

// The G-TAKE offer (fixtures/README.md): a live stagenet ladder bid, the maker gives 1 wUSDC and
// wants 104.166667 wStkA. The wallet's side is balanced by the REAL SDK coin selection over a
// fixture shielded state; `mockProve` stands in for the sponsor's proof (it proves nothing, but
// yields a transaction of the proven type, bound).

const OFFER = fixture<{ offerId: string; offerBech32: string }>('stagenet-bid-9ed57eec.json');
const WANTED = 104_166_667n;

/** What the sponsor's `/prove` would answer, for the offline tests: a proven-typed hex. */
const mockProven = (unprovenHex: string) => txToHex(unprovenFromHex(unprovenHex).mockProve());

/** A separately balanced shielded transfer from `wallet` (to itself): what a prover could add to a
 *  draft without changing any colour's imbalance (the audit's F-B9). */
async function balancedTransfer(wallet: TempWallet, colour: string, amount: bigint) {
  const { opened, keys } = internalsOf(wallet);
  const self = (await firstValueFrom(opened.wallet.state)).address;
  return opened.wallet.transferTransaction(keys.shieldedSecretKeys, [{ type: colour, receiverAddress: self, amount }]);
}

describe('buildTake: the unproven, shielded-balanced complement of an offer', () => {
  it("balances exactly the maker's legs from the wallet's coin, with no DUST", async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: WANTED }]);
    const draft = await buildTake(wallet, OFFER.offerBech32);
    expect(draft.offerId).toBe(OFFER.offerId);
    expect(draft.terms).toEqual({
      give: [{ colour: WSTKA, amount: WANTED }],
      receive: [{ colour: WUSDC, amount: 1_000_000n }],
    });
    const tx = unprovenFromHex(draft.tx);
    expect(txToHex(tx)).toBe(draft.tx);
    expect(shieldedImbalances(tx)).toEqual({ [WSTKA]: WANTED, [WUSDC]: -1_000_000n });
    expect(dustSpendCount(tx)).toBe(0);
    expect(tx.intents?.size ?? 0).toBe(0);
    expect(draft.identifiers.length).toBeGreaterThanOrEqual(2);
    // The coin is booked while the take is in flight.
    expect((await wallet.balances())[WSTKA] ?? 0n).toBe(0n);
    await draft.release();
    expect((await wallet.balances())[WSTKA]).toBe(WANTED);
    await wallet.close();
  });

  it('keeps the change of a bigger coin in the wallet', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: 200_000_000n }]);
    const draft = await buildTake(wallet, OFFER.offerBech32);
    expect(shieldedImbalances(unprovenFromHex(draft.tx))).toEqual({ [WSTKA]: WANTED, [WUSDC]: -1_000_000n });
    await draft.release();
    await wallet.close();
  });

  it('refuses before booking anything when the wallet cannot pay the wanted leg', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: WANTED - 1n }]);
    await expect(buildTake(wallet, OFFER.offerBech32)).rejects.toMatchObject({ code: 'insufficient-funds' });
    expect((await wallet.balances())[WSTKA]).toBe(WANTED - 1n);
    await wallet.close();
  });

  it('refuses an empty wallet (a fresh swap before its deposit is minted)', async () => {
    const wallet = await walletWithCoins(TEST_SEED_B, []);
    await expect(buildTake(wallet, OFFER.offerBech32)).rejects.toBeInstanceOf(TakeError);
    await wallet.close();
  });
});

describe('finalizeTake: bind the proven complement and merge it into the offer', () => {
  it('gives a settlement balanced in every shielded colour that the batcher takes', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: WANTED }]);
    const draft = await buildTake(wallet, OFFER.offerBech32);
    const settlement = finalizeTake(draft, mockProven(draft.tx));
    const tx = decodeMakerTransaction(OFFER.offerBech32);
    const merged = tx.merge(unprovenFromHex(draft.tx).mockProve());
    expect(Object.values(shieldedImbalances(merged)).every((v) => v === 0n)).toBe(true);
    expect(settlement.offerId).toBe(OFFER.offerId);
    expect(settlement.txBytes).toBe(settlement.tx.length / 2);
    expect(JSON.stringify({ tx: settlement.tx, txStage: 'finalized' }).length).toBeLessThan(MAX_INPUT_CHARS);
    // The settlement carries the maker's transaction: its identifiers are all there.
    const ids = new Set(
      (await import('@midnightntwrk/ledger-v9')).Transaction.deserialize(
        'signature',
        'proof',
        'binding',
        Uint8Array.from(Buffer.from(settlement.tx, 'hex')),
      )
        .identifiers()
        .map(String),
    );
    for (const id of tx.identifiers()) expect(ids.has(String(id))).toBe(true);
    expect(offerIdOf(tx.serialize())).toBe(OFFER.offerId);
    await wallet.close();
  });

  it('keeps the coin booked after finalizing, until release or the spend lands: the lifecycle the web mock follows (P4.2-fix2 R3, F-B24)', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: WANTED }]);
    const draft = await buildTake(wallet, OFFER.offerBech32);
    finalizeTake(draft, mockProven(draft.tx));
    // Finalized and handed on, not landed: nothing is given back (the same SDK booking as a
    // withdrawal's: `balanceTransaction` books, only `revertTransaction` or the landed spend frees).
    expect((await wallet.balances())[WSTKA] ?? 0n).toBe(0n);
    await expect(buildTake(wallet, OFFER.offerBech32)).rejects.toMatchObject({ code: 'insufficient-funds' });
    await draft.release();
    expect((await wallet.balances())[WSTKA]).toBe(WANTED);
    await wallet.close();
  });

  it('the offer id is sha256 of the maker bytes AS SERVED (P4.2-fix C10)', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: WANTED }]);
    const draft = await buildTake(wallet, OFFER.offerBech32);
    expect(servedOfferId(OFFER.offerBech32)).toBe(OFFER.offerId);
    expect(draft.offerId).toBe(offerIdOf(decodeOffer(OFFER.offerBech32)));
    await draft.release();
    await wallet.close();
  });

  it('refuses a proven answer that adds a separately balanced transfer (P4.2-fix C10, F-B9)', async () => {
    const a = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: WANTED }]);
    const b = await walletWithCoins(TEST_SEED_B, [{ colour: WUSDC, value: 5_000_000n }]);
    const draft = await buildTake(a, OFFER.offerBech32);
    const extra = await balancedTransfer(b, WUSDC, 1_000_000n);
    // Every identifier of the draft is still there, and every colour still balances against the offer.
    const tampered = unprovenFromHex(draft.tx).merge(extra).mockProve();
    const ids = new Set(tampered.identifiers().map(String));
    expect(draft.identifiers.every((id) => ids.has(id))).toBe(true);
    expect(() => finalizeTake(draft, txToHex(tampered))).toThrow(expect.objectContaining({ code: 'proof-mismatch' }));
    // The honest answer still passes.
    expect(finalizeTake(draft, mockProven(draft.tx)).offerId).toBe(OFFER.offerId);
    await Promise.all([a.close(), b.close()]);
  });

  it("refuses a proven transaction that is not this take's (another wallet's complement)", async () => {
    const a = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: WANTED }]);
    const b = await walletWithCoins(TEST_SEED_B, [{ colour: WSTKA, value: WANTED }]);
    const draftA = await buildTake(a, OFFER.offerBech32);
    const draftB = await buildTake(b, OFFER.offerBech32);
    expect(() => finalizeTake(draftA, mockProven(draftB.tx))).toThrow(
      expect.objectContaining({ code: 'proof-mismatch' }),
    );
    await Promise.all([a.close(), b.close()]);
  });

  it('refuses an unproven or garbled answer, and a released take', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: WANTED }]);
    const draft = await buildTake(wallet, OFFER.offerBech32);
    expect(() => finalizeTake(draft, draft.tx)).toThrow(/not a proven/);
    expect(() => finalizeTake(draft, 'zz')).toThrow(/not hex/);
    await draft.release();
    expect(() => finalizeTake(draft, mockProven(draft.tx))).toThrow(expect.objectContaining({ code: 'released' }));
    await wallet.close();
  });
});

describe('submitTake: the batcher', () => {
  const okFetch = (body: unknown, status = 200) =>
    vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

  it("posts the settlement as the SPA does, naming the temporary wallet's unshielded address", async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: WANTED }]);
    const draft = await buildTake(wallet, OFFER.offerBech32);
    const settlement = finalizeTake(draft, mockProven(draft.tx));
    const f = okFetch({ success: true, transactionHash: 'ab'.repeat(32) });
    const res = await submitTake(wallet, settlement, { fetchImpl: f as unknown as typeof fetch });
    expect(res).toMatchObject({ ok: true, lostRace: false, transactionHash: 'ab'.repeat(32) });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe('https://stagenet.batcher-zswap.zkdojo.com/send-input');
    const body = JSON.parse(String(init!.body));
    expect(body.data.address).toBe(wallet.unshieldedAddress);
    expect(body.data.target).toBe('midnight-balancer');
    expect(JSON.parse(body.data.input)).toEqual({ tx: settlement.tx, txStage: 'finalized' });
    await wallet.close();
  });

  it('flags a lost race (239 NullifierAlreadyPresent): "Swap is not available"', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, []);
    for (const error of ['Transaction failed: Custom error: 239', 'NullifierAlreadyPresent']) {
      const res = await submitTake(wallet, 'ab', {
        fetchImpl: okFetch({ success: false, error }, 500) as unknown as typeof fetch,
      });
      expect(res.ok).toBe(false);
      expect(res.lostRace).toBe(true);
    }
    const other = await submitTake(wallet, 'ab', {
      fetchImpl: okFetch({ success: false, error: 'rate limited' }, 429) as unknown as typeof fetch,
    });
    expect(other.lostRace).toBe(false);
    await wallet.close();
  });
});

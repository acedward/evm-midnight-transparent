import { readFileSync } from 'node:fs';

import { type ShieldedWalletAPI } from '@midnightntwrk/wallet-sdk-shielded';
import { describe, expect, it, vi } from 'vitest';

import { offerIdOf } from '@evm-midnight-transparent/core';

import { type ProvingService } from '../src/prover.js';
import { TakeError, buildTake, decodeMakerTransaction, shieldedImbalances, takeTerms } from '../src/take.js';

// A live stagenet ladder bid, captured from the kernel (public data): the maker gives 1 wUSDC and
// wants 104.166667 wStkA.
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/stagenet-bid-9ed57eec.json', import.meta.url), 'utf8')) as {
  offerId: string;
  offerBech32: string;
  computed: { gives: { colour: string; amount: string }[]; wants: { colour: string; amount: string }[] };
};
const WUSDC = 'e5afe273bcb1252cfbc81ad6ca1caaafe22312c8c29f9b104a2fe3ead980bb2d';
const WSTKA = '5eb2a3cebb2ebe7ba910c78f62c9e28e0d74acbd00c810730def3578860e6a02';

describe('reading a kernel offer', () => {
  it('decodes the maker transaction; its id is the kernel id', () => {
    const tx = decodeMakerTransaction(FIXTURE.offerBech32);
    expect(offerIdOf(tx.serialize())).toBe(FIXTURE.offerId);
  });

  it("reads the taker's terms from the transaction itself, matching the kernel's legs", () => {
    const terms = takeTerms(decodeMakerTransaction(FIXTURE.offerBech32));
    expect(terms).toEqual({
      give: [{ colour: WSTKA, amount: 104_166_667n }],
      receive: [{ colour: WUSDC, amount: 1_000_000n }],
    });
    expect(terms.give.map((l) => [l.colour, String(l.amount)])).toEqual(
      FIXTURE.computed.wants.map((l) => [l.colour, l.amount]),
    );
    expect(terms.receive.map((l) => [l.colour, String(l.amount)])).toEqual(
      FIXTURE.computed.gives.map((l) => [l.colour, l.amount]),
    );
  });

  it('an offer is imbalanced by exactly its legs', () => {
    expect(shieldedImbalances(decodeMakerTransaction(FIXTURE.offerBech32))).toEqual({
      [WUSDC]: 1_000_000n,
      [WSTKA]: -104_166_667n,
    });
  });
});

describe('building a take (offline paths)', () => {
  const makerTx = decodeMakerTransaction(FIXTURE.offerBech32);
  const prover: ProvingService = { prove: vi.fn() };

  it('refuses before touching the wallet when it cannot pay the wanted leg', async () => {
    const wallet = { balanceTransaction: vi.fn(), revertTransaction: vi.fn() };
    const err = await buildTake({
      makerTx,
      wallet: wallet as unknown as ShieldedWalletAPI,
      secretKeys: {} as never,
      prover,
      balances: { [WSTKA]: 104_166_666n },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TakeError);
    expect((err as TakeError).code).toBe('insufficient-funds');
    expect(wallet.balanceTransaction).not.toHaveBeenCalled();
  });

  it('refuses when the wallet has nothing to balance', async () => {
    const wallet = { balanceTransaction: vi.fn(async () => undefined), revertTransaction: vi.fn() };
    await expect(
      buildTake({
        makerTx,
        wallet: wallet as unknown as ShieldedWalletAPI,
        secretKeys: {} as never,
        prover,
        balances: { [WSTKA]: 104_166_667n },
      }),
    ).rejects.toMatchObject({ code: 'nothing-to-balance' });
  });

  it('releases the booked coins when proving fails', async () => {
    const balancing = { intents: undefined };
    const wallet = {
      balanceTransaction: vi.fn(async () => balancing),
      revertTransaction: vi.fn(async () => undefined),
    };
    const failing: ProvingService = {
      prove: vi.fn(async () => {
        throw new Error('the proof server is down');
      }),
    };
    await expect(
      buildTake({
        makerTx,
        wallet: wallet as unknown as ShieldedWalletAPI,
        secretKeys: {} as never,
        prover: failing,
        balances: { [WSTKA]: 104_166_667n },
      }),
    ).rejects.toThrow('the proof server is down');
    expect(wallet.revertTransaction).toHaveBeenCalledWith(balancing);
  });

  it('refuses a balancing transaction that spends DUST (the batcher pays the fee)', async () => {
    const balancing = { intents: new Map([[1, { dustActions: { spends: [{}] } }]]) };
    const wallet = {
      balanceTransaction: vi.fn(async () => balancing),
      revertTransaction: vi.fn(async () => undefined),
    };
    await expect(
      buildTake({
        makerTx,
        wallet: wallet as unknown as ShieldedWalletAPI,
        secretKeys: {} as never,
        prover,
        balances: { [WSTKA]: 104_166_667n },
      }),
    ).rejects.toMatchObject({ code: 'not-balanced' });
    expect(wallet.revertTransaction).toHaveBeenCalledWith(balancing);
  });
});

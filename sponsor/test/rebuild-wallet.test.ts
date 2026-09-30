// The sponsor's withdraw rule against the REAL wallet (L-WALLET's `buildWithdraw`) on REAL stagenet
// state, offline: the vault's state recorded at block 679,357 (packages/wallet/test/fixtures), the
// compiled vault vendored in the wallet (passport 6c7505a, compactc 0.34.0), and G-BRIDGE B.3.1's
// arguments. The wallet builds and balances its startWithdraw; the sponsor rebuilds the calls from the
// swap's values and the two hints, and they must be identical. And G-BRIDGE's own proven, bound
// startWithdraw (the transaction the sponsor paid DUST for live) passes the shape rules.

import { readFileSync } from 'node:fs';

import * as l from '@midnightntwrk/ledger-v9';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { DEFAULT_EVM_GAS, STAGENET, decodeOffer, hexToBytes } from '@evm-midnight-transparent/core';
import { buildTake, buildWithdraw, temporaryWalletKeys } from '@evm-midnight-transparent/wallet';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { beforeAll, describe, expect, it } from 'vitest';

import * as vault from '../../packages/wallet/src/vendor/vault/Erc20Vault/contract/index.js';
import {
  TEST_SEED_A,
  WSTKA,
  WUSDC,
  fixture,
  fixtureReader,
  walletWithCoins,
  type VaultFixture,
} from '../../packages/wallet/test/helpers.js';
import { requestDetail } from '../src/bridge/live-backend.js';
import { rebuildStartWithdraw } from '../src/bridge/rebuild.js';
import type { WithdrawCallArgs } from '../src/swaps/backend.js';
import { inspectTransaction, makerImbalances, summarise, walletCoinCommitment } from '../src/validate/inspect.js';
import { InvalidTxError, gasClose, validateTake, validateWithdraw } from '../src/validate/rules.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const AT_679357 = fixture<VaultFixture>('stagenet-vault-679357.json');
const B31 = {
  evmNonce: 9n,
  dest: '0x484738A67858305Edfc139B194Ed430Fe4D8e56b',
  amount: 1_000_000n,
  requestId: '21d8b43db31bc94cc782eb460fc5cf2cf260fbeffe44938606f6b75660822900',
};
const STKA_ERC20 = '0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52';
const VAULT = STAGENET.bridge.vaultAddress;

// midnight-js renders the coin public key with a module-global network id (the live backend sets it).
beforeAll(() => setNetworkId('stagenet' as never));

const runtime = {
  compiledContract: (CompiledContract as any)
    .make('erc20-vault', (vault as any).Contract)
    .pipe((CompiledContract as any).withVacantWitnesses),
  ledger: (s: unknown) => (vault as any).ledger(s),
};

const detailOf = (fn: () => void): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof InvalidTxError) return e.detail;
    throw e;
  }
  return 'accepted';
};

async function walletDraft() {
  const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: B31.amount }]);
  const draft = await buildWithdraw(
    wallet,
    { colour: WSTKA, amount: B31.amount, dest: B31.dest, evmNonce: B31.evmNonce },
    { reader: fixtureReader(AT_679357) },
  );
  return { wallet, draft };
}

const argsFor = (
  wallet: { coinPk: string; encPk: string },
  coinNonce: string,
  over: Partial<WithdrawCallArgs> = {},
): WithdrawCallArgs => ({
  evmNonce: B31.evmNonce,
  gas: DEFAULT_EVM_GAS,
  erc20: STKA_ERC20,
  amount: B31.amount,
  dest: B31.dest,
  colour: WSTKA,
  coinNonce,
  refundCoinPk: wallet.coinPk,
  tempCoinPk: wallet.coinPk,
  tempEncPk: wallet.encPk,
  ...over,
});

describe('the sponsor’s rebuild equals the wallet’s build (recorded stagenet state, G-BRIDGE arguments)', () => {
  it('accepts the wallet’s startWithdraw: identical calls, the same request as G-BRIDGE’s live one', async () => {
    const { wallet, draft } = await walletDraft();
    const { summary } = inspectTransaction(hexToBytes(draft.tx), 'unproven');
    const rebuilt = await rebuildStartWithdraw(
      runtime,
      fixtureReader(AT_679357),
      VAULT,
      argsFor(wallet, draft.coinNonce),
    );
    expect(rebuilt.requestId).toBe(B31.requestId);
    // The request record as the vault stores it: its transaction fields, read by the live
    // backend's requestDetail (the deposit adoption rule of audit C12 reads the same shape).
    expect(requestDetail(rebuilt.request)).toEqual({
      erc20: STKA_ERC20.toLowerCase(),
      amount: B31.amount,
      evmNonce: B31.evmNonce,
      gasLimit: DEFAULT_EVM_GAS.gasLimit,
      maxFeePerGas: DEFAULT_EVM_GAS.maxFeePerGas,
    });
    expect(requestDetail({ txParams: { to: 'x' } })).toBeUndefined();
    expect(rebuilt.calls.map((c) => c.entryPoint)).toEqual(['startWithdraw', 'signBidirectional']);
    // The calls are identical but for their declared gas, which the callee's random commitment moves
    // a little (compared with a tolerance by the rule).
    const bare = (cs: typeof summary.calls) => cs.map(({ gas: _gas, ...c }) => c);
    expect(bare(summary.calls)).toEqual(bare(rebuilt.calls));
    summary.calls.forEach((c, i) => expect(gasClose(c.gas, rebuilt.calls[i]!.gas)).toBe(true));
    expect(detailOf(() => validateWithdraw(summary, rebuilt, WSTKA))).toBe('accepted');
    // Audit C4: the coin the wallet hands to the vault is exactly the rebuild's (same commitment,
    // owned by the vault), and the transaction's structure digest (calls, segments, every coin) is
    // what /withdraw must carry: erasing the proof material and binding keep it.
    expect(rebuilt.outputs).toHaveLength(1);
    expect(rebuilt.outputs[0]!.contract).toBe(VAULT);
    expect(summary.shielded.outputs.filter((o) => o.contract !== null)).toEqual(rebuilt.outputs);
    expect(summary.shielded.inputs).toHaveLength(1);
    const tx = l.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', hexToBytes(draft.tx)) as any;
    expect(summarise(tx.eraseProofs()).structureDigest).toBe(summary.structureDigest);
    expect(summarise(tx.bind()).structureDigest).toBe(summary.structureDigest);
    await draft.release();
    await wallet.close();
  });

  it('agrees over many fresh builds: the random callee commitment moves the declared gas a little, never the calls (found in P4.2-fix CI)', async () => {
    // About 1 build in 40 declared a slightly different compute time (the commitment's encoded
    // length); the digests used to include it, so a valid withdrawal was refused as wrong-call.
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: B31.amount }]);
    for (let i = 0; i < 60; i++) {
      const draft = await buildWithdraw(
        wallet,
        { colour: WSTKA, amount: B31.amount, dest: B31.dest, evmNonce: B31.evmNonce },
        { reader: fixtureReader(AT_679357) },
      );
      const { summary } = inspectTransaction(hexToBytes(draft.tx), 'unproven');
      const rebuilt = await rebuildStartWithdraw(
        runtime,
        fixtureReader(AT_679357),
        VAULT,
        argsFor(wallet, draft.coinNonce),
      );
      expect(detailOf(() => validateWithdraw(summary, rebuilt, WSTKA))).toBe('accepted');
      await draft.release();
    }
    await wallet.close();
  }, 120_000);

  it('refuses a withdrawal whose calls declare more gas than the rebuild (the sponsor’s DUST pays for it)', async () => {
    const { wallet, draft } = await walletDraft();
    const { summary } = inspectTransaction(hexToBytes(draft.tx), 'unproven');
    const rebuilt = await rebuildStartWithdraw(
      runtime,
      fixtureReader(AT_679357),
      VAULT,
      argsFor(wallet, draft.coinNonce),
    );
    const g = summary.calls[0]!.gas!.guaranteed!;
    expect(Object.keys(g).length).toBeGreaterThan(0);
    const inflate = (pct: bigint) => ({
      ...summary,
      calls: summary.calls.map((c, i) =>
        i === 0
          ? {
              ...c,
              gas: {
                ...c.gas!,
                guaranteed: Object.fromEntries(
                  Object.entries(g).map(([k, v]) => [k, ((BigInt(v) * (1000n + pct)) / 1000n).toString()]),
                ),
              },
            }
          : c,
      ),
    });
    expect(detailOf(() => validateWithdraw(inflate(20n), rebuilt, WSTKA))).toBe('wrong-call'); // +2%
    expect(detailOf(() => validateWithdraw(inflate(5n), rebuilt, WSTKA))).toBe('accepted'); // +0.5%
    await draft.release();
    await wallet.close();
  });

  it('refuses it for another destination, amount, refund recipient, EVM nonce or coin (wrong call)', async () => {
    const { wallet, draft } = await walletDraft();
    const { summary } = inspectTransaction(hexToBytes(draft.tx), 'unproven');
    const reader = fixtureReader(AT_679357);
    for (const over of [
      { dest: '0x000000000000000000000000000000000000dEaD' },
      { refundCoinPk: '77'.repeat(32) },
      { evmNonce: 10n },
      { coinNonce: '33'.repeat(32) },
    ] as Partial<WithdrawCallArgs>[]) {
      const rebuilt = await rebuildStartWithdraw(runtime, reader, VAULT, argsFor(wallet, draft.coinNonce, over));
      expect(detailOf(() => validateWithdraw(summary, rebuilt, WSTKA))).toBe('wrong-call');
    }
    await draft.release();
    await wallet.close();
  });
});

describe('G-BRIDGE’s live startWithdraw (the transaction the sponsor paid DUST for)', () => {
  it('reads as one intent with the vault’s and the singleton’s calls, balanced, no DUST, no unshielded', () => {
    const hex = readFileSync(
      new URL('../../packages/wallet/test/fixtures/g-bridge-startwithdraw-proven.hex', import.meta.url),
      'utf8',
    ).trim();
    const { summary } = inspectTransaction(hexToBytes(hex), 'final');
    expect(summary).toMatchObject({
      intents: 1,
      deploys: 0,
      maintenanceUpdates: 0,
      unshielded: false,
      dust: false,
      fallibleShielded: false,
    });
    expect(summary.calls.map((c) => [c.address, c.entryPoint])).toEqual([
      [VAULT, 'startWithdraw'],
      [STAGENET.bridge.signetSingleton, 'signBidirectional'],
    ]);
    expect(summary.imbalances).toEqual({});
    expect(summary.guaranteed!.inputs).toBeGreaterThanOrEqual(1);
    // The shape rules accept it (its own calls as the expected ones): nothing in the rules refuses a real startWithdraw.
    expect(
      detailOf(() => validateWithdraw(summary, { calls: summary.calls, callsDigest: summary.callsDigest }, WSTKA)),
    ).toBe('accepted');
    // Audit C4's coin rule on the live transaction: one coin in, one coin out, owned by the vault.
    const vaultCoins = summary.shielded.outputs.filter((o) => o.contract !== null);
    expect(vaultCoins).toEqual([{ commitment: expect.stringMatching(/^[0-9a-f]{64}$/), contract: VAULT }]);
    expect(summary.shielded.inputs).toHaveLength(1);
    expect(
      detailOf(() =>
        validateWithdraw(
          summary,
          { calls: summary.calls, callsDigest: summary.callsDigest, outputs: vaultCoins },
          WSTKA,
        ),
      ),
    ).toBe('accepted');
    // ...and it is a finalized transaction, not an unproven one.
    expect(() => l.Transaction.deserialize('signature', 'proof', 'binding', hexToBytes(hex))).not.toThrow();
  });
});
describe('the take: the wallet’s balancing transaction for the G-TAKE bid', () => {
  const BID = fixture<{ offerId: string; offerBech32: string }>('stagenet-bid-9ed57eec.json');
  const terms = {
    pay: { colour: WSTKA, amount: 104_166_667n },
    receive: { colour: WUSDC, amount: 1_000_000n },
  };

  it('the maker’s own transaction gives 1 wUSDC and wants 104.166667 wStkA (what open-swap checks)', () => {
    expect(makerImbalances(decodeOffer(BID.offerBech32))).toEqual({ [WUSDC]: 1_000_000n, [WSTKA]: -104_166_667n });
  });

  it('accepts the wallet’s real balancing transaction for this offer, and refuses it for other terms', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: terms.pay.amount }]);
    const draft = await buildTake(wallet, BID.offerBech32);
    const { summary } = inspectTransaction(hexToBytes(draft.tx), 'unproven');
    expect(summary.intents).toBe(0);
    expect(detailOf(() => validateTake(summary, terms))).toBe('accepted');
    expect(detailOf(() => validateTake(summary, { ...terms, receive: { colour: WUSDC, amount: 999_999n } }))).toBe(
      'wrong-amount',
    );
    expect(detailOf(() => validateTake(summary, { pay: terms.receive, receive: terms.pay }))).toBe('wrong-offer');
    await draft.release();
    await wallet.close();
  });
});

describe('R1 on the real ledger: the outputs the wallet discloses, recomputed by the sponsor (plan Lane contracts, FS2 item 1)', () => {
  const BID = fixture<{ offerId: string; offerBech32: string }>('stagenet-bid-9ed57eec.json');
  const terms = {
    pay: { colour: WSTKA, amount: 104_166_667n },
    receive: { colour: WUSDC, amount: 1_000_000n },
  };

  /** ledger-v9 `coinCommitment` (the sponsor's `walletCoinCommitment` is checked equal below). */
  const commitment = (o: { nonce: string; colour: string; value: bigint }, coinPk: string) =>
    String(l.coinCommitment({ type: o.colour, nonce: o.nonce, value: o.value } as any, coinPk as any)).toLowerCase();

  /** The Lane contracts recipe: the wallet decrypts its own outputs of the unproven transaction. */
  const walletOutputsOf = (txHex: string) => {
    const keys = temporaryWalletKeys(TEST_SEED_A, 'stagenet');
    const tx = l.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', hexToBytes(txHex)) as any;
    const coins = [...new l.ZswapLocalState().apply(keys.shieldedSecretKeys, tx.guaranteedOffer).coins];
    keys.clear();
    return coins.map((c: any) => ({ nonce: String(c.nonce), colour: String(c.type), value: BigInt(c.value) }));
  };

  it('a take with change: the received coin and the change are the wallet’s; withheld, they are refused', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: 200_000_000n }]);
    const draft = await buildTake(wallet, BID.offerBech32);
    const { summary } = inspectTransaction(hexToBytes(draft.tx), 'unproven');
    const outs = walletOutputsOf(draft.tx);
    expect(outs.map((o) => [o.colour, o.value])).toEqual(
      expect.arrayContaining([
        [WUSDC, 1_000_000n],
        [WSTKA, 95_833_333n],
      ]),
    );
    const all = new Set(outs.map((o) => commitment(o, wallet.coinPk)));
    expect([...all].sort()).toEqual(summary.shielded.outputs.map((x) => x.commitment.toLowerCase()).sort());
    // FW2's draft discloses exactly these (packages/wallet/src/outputs.ts, the same recipe).
    expect(new Set(draft.walletOutputs.map((o) => commitment(o, wallet.coinPk)))).toEqual(all);
    expect(detailOf(() => validateTake(summary, terms, { walletOutputs: all }))).toBe('accepted');
    const noChange = new Set(outs.filter((o) => o.colour === WUSDC).map((o) => commitment(o, wallet.coinPk)));
    expect(detailOf(() => validateTake(summary, terms, { walletOutputs: noChange }))).toBe('undisclosed-output');
    expect(detailOf(() => validateTake(summary, terms, { walletOutputs: new Set() }))).toBe('undisclosed-output');
    // Recomputed with another key, the same coins are not the wallet's.
    const otherKey = new Set(outs.map((o) => commitment(o, '77'.repeat(32))));
    expect(detailOf(() => validateTake(summary, terms, { walletOutputs: otherKey }))).toBe('undisclosed-output');
    // The sponsor's recomputation (main.ts wires it) is ledger-v9's.
    for (const o of outs) expect(walletCoinCommitment(o, wallet.coinPk)).toBe(commitment(o, wallet.coinPk));
    await draft.release();
    await wallet.close();
  });

  it('a withdrawal with change: accepted with the change disclosed, refused without; the bound form erases to the same bytes', async () => {
    const wallet = await walletWithCoins(TEST_SEED_A, [{ colour: WSTKA, value: 3_000_000n }]);
    const draft = await buildWithdraw(
      wallet,
      { colour: WSTKA, amount: B31.amount, dest: B31.dest, evmNonce: B31.evmNonce },
      { reader: fixtureReader(AT_679357) },
    );
    const { summary } = inspectTransaction(hexToBytes(draft.tx), 'unproven');
    const rebuilt = await rebuildStartWithdraw(
      runtime,
      fixtureReader(AT_679357),
      VAULT,
      argsFor(wallet, draft.coinNonce),
    );
    const outs = walletOutputsOf(draft.tx);
    expect(outs.map((o) => [o.colour, o.value])).toEqual([[WSTKA, 2_000_000n]]);
    const change = new Set(outs.map((o) => commitment(o, wallet.coinPk)));
    expect(new Set(draft.walletOutputs.map((o) => commitment(o, wallet.coinPk)))).toEqual(change);
    expect(detailOf(() => validateWithdraw(summary, rebuilt, WSTKA, { walletOutputs: change }))).toBe('accepted');
    expect(detailOf(() => validateWithdraw(summary, rebuilt, WSTKA, { walletOutputs: new Set() }))).toBe(
      'undisclosed-output',
    );
    // /withdraw compares the whole proof-erased transaction: binding does not change it.
    const tx = l.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', hexToBytes(draft.tx)) as any;
    expect(summary.erased).toMatch(/^[0-9a-f]+$/);
    expect(summarise(tx.bind()).erased).toBe(summary.erased);
    await draft.release();
    await wallet.close();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

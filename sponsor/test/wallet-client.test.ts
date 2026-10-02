// Wire compatibility: L-WALLET's sponsor client (packages/wallet/src/sponsor-client.ts), unchanged,
// against this sponsor's routes (with fakes behind them): withdraw-params, /prove for a take and a
// withdrawal (with its hints, without naming the kind), /take, /withdraw, and a refusal surfacing as
// the wallet's SponsorApiError with `rebuild` set.

import { SponsorApiError, sponsorClient } from '@evm-midnight-transparent/wallet';
import { describe, expect, it } from 'vitest';

import { VAULT_EVM } from './fakes.js';
import { BID, bidTakeFor, harness, mintedSwap, testConfig, tok, txHex, withdrawFor } from './harness.js';

describe('the wallet’s sponsor client against the sponsor', () => {
  it('drives a whole take and withdrawal', async () => {
    const h = harness({ config: testConfig({ RATE_LIMIT_PROVES_PER_SWAP_PER_MIN: '100' }) });
    h.vault.evm.nonces.set(VAULT_EVM.toLowerCase(), { latest: 9n, pending: 9n });
    h.vault.evm.setEth(VAULT_EVM, 10n ** 17n);
    h.vault.evm.setErc20(tok('USDC').sepoliaAddress, VAULT_EVM, 10n ** 12n);
    const { s, token } = await mintedSwap(h);
    const take = bidTakeFor(s);
    const client = sponsorClient({
      baseUrl: 'http://sponsor.test',
      swapId: `0x${s.swapId}`,
      swapToken: token,
      fetchImpl: ((url: string, init: RequestInit) => h.app.request(url, init)) as typeof fetch,
    });

    // take, disclosing the coin it pays to the temporary wallet (P4.2-fix2 R1, FW2's `disclosure`)
    const walletOutputs = take.walletOutputs.map((o) => ({ ...o, value: BigInt(o.value) }));
    const proven = await client.prove('take', txHex(take.tx), undefined, { walletOutputs });
    expect(Buffer.from(proven, 'hex').toString('utf8')).toMatch(/^PROVEN:/);
    await client.reportTake({ outcome: 'taken', takeTx: `0x${'ab'.repeat(32)}` });
    expect(h.store.get(s.swapId)!).toMatchObject({ state: 'taken', takeTx: 'ab'.repeat(32) });

    // withdraw-params, as the wallet parses them
    const params = await client.withdrawParams('swap');
    expect(params).toMatchObject({
      kind: 'swap',
      colour: BID.receive.token.midnightColour,
      amount: 1_000_000n,
      dest: s.user.address,
      refundRecipient: s.payload.tempCoinPk,
      evmNonce: 9n,
      gas: { gasLimit: 100_000n, maxFeePerGas: 10_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, keyVersion: 1n },
    });

    // a refusal: the wallet sees the sponsor's code, and `rebuild` for a stale nonce
    const stale = withdrawFor(h, s, 'swap', { evmNonce: 8n });
    const e = await client
      .prove('withdraw', txHex(stale.tx), { coinNonce: stale.coinNonce, evmNonce: stale.evmNonce })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SponsorApiError);
    expect(e).toMatchObject({ status: 409, code: 'stale-evm-nonce', rebuild: true });

    // prove (the kind is inferred) and withdraw
    const w = withdrawFor(h, s, 'swap');
    await client.prove('withdraw', txHex(w.tx), { coinNonce: w.coinNonce, evmNonce: w.evmNonce });
    const answer = (await client.withdraw(txHex(w.tx))) as { swap: { state: string } };
    expect(answer.swap.state).toBe('withdrawing');
    await h.swaps.idle();
    expect(h.store.get(s.swapId)!).toMatchObject({ state: 'done', outcome: 'swapped' });
  });
});

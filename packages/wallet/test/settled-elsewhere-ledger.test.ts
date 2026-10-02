// Plan 00048 P4.2-fix4 (lane FS4), the audit's T1 / F-A41, on the REAL ledger (ledger-v9 rc.3), and
// why the fix is containment, not recovery (questions file Q16):
//  1. a vault settle discloses the minted coin's COMMITMENT and the mint amount, never its nonce
//     (G-BRIDGE's live `completeDeposit`, fixtures/g-bridge-complete-deposit.json);
//  2. a temporary wallet finds a coin minted to its coin key only through a ciphertext sealed to ITS
//     encryption key, or by `watchFor` with the coin's full description, nonce included. A settler who
//     seals the coin to another key and keeps the nonce leaves the coin out of the wallet's reach.

import { readFileSync } from 'node:fs';

import * as ledger from '@midnightntwrk/ledger-v9';
import { describe, expect, it } from 'vitest';

import { temporaryWalletKeys } from '../src/keys.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/g-bridge-complete-deposit.json', import.meta.url), 'utf8'),
) as {
  hash: string;
  identifiers: string[];
  midnightJsTxId: string;
  requestId: string;
  mintedCoin: { nonce: string; color: string; value: string };
  coinPublicKey: string;
  raw: string;
};

const VAULT = '7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637';
const reversed = (hex: string) => Buffer.from(hex, 'hex').reverse().toString('hex');

describe('T1 on the real ledger: a settle discloses the minted coin’s commitment, never its nonce', () => {
  const bytes = Buffer.from(fixture.raw, 'hex');
  const tx: Any = (ledger.Transaction as Any).deserialize('signature', 'proof', 'binding', bytes);
  const coin = {
    nonce: fixture.mintedCoin.nonce,
    type: fixture.mintedCoin.color,
    value: BigInt(fixture.mintedCoin.value),
  };

  it('the live completeDeposit’s vault call carries the mint and ONE commitment: the coin minted to the temporary coin key', () => {
    const calls: Any[] = [];
    for (const [, intent] of tx.intents ?? new Map()) for (const a of intent.actions) calls.push(a);
    expect(calls.map((c) => [c.address, c.entryPoint])).toEqual([[VAULT, 'completeDeposit']]);
    const effects = calls[0].guaranteedTranscript.effects;
    expect([...effects.shieldedMints.values()]).toEqual([1_000_000n]);
    expect(effects.claimedShieldedSpends).toHaveLength(1);
    const commitment = String(effects.claimedShieldedSpends[0]);
    // The commitment is the coin's, owned by the temporary coin key; it is also the transaction's only
    // shielded output (no contract address: a user's coin).
    expect((ledger as Any).coinCommitment(coin, fixture.coinPublicKey)).toBe(commitment);
    expect(tx.guaranteedOffer.outputs.map((o: Any) => [String(o.commitment), o.contractAddress])).toEqual([
      [commitment, undefined],
    ]);
  });

  it('the nonce appears nowhere in the transaction (in either byte order), while the other public values do: it cannot be read from the chain', () => {
    // The search works: the values the transcript discloses are in the bytes (the transcript drops a
    // value's trailing zero bytes, so the request id `…3c00` appears as `…3c`).
    expect(fixture.raw.includes(fixture.coinPublicKey)).toBe(true);
    expect(fixture.raw.includes(fixture.requestId.replace(/(00)+$/, ''))).toBe(true);
    expect(fixture.raw.includes('2ab7be0769e3bbd5c7d047b422cb383fcc06fb52')).toBe(true); // the ERC20
    // The nonce (no trailing zero byte) is in neither the bytes nor the decoded transcript.
    expect(coin.nonce.endsWith('00')).toBe(false);
    expect(fixture.raw.includes(coin.nonce)).toBe(false);
    expect(fixture.raw.includes(reversed(coin.nonce))).toBe(false);
    const calls: Any[] = [];
    for (const [, intent] of tx.intents ?? new Map()) for (const a of intent.actions) calls.push(a);
    const program = JSON.stringify(calls[0].guaranteedTranscript.program, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v,
    );
    expect(program).toContain(fixture.coinPublicKey); // the stored recipient, read by the circuit
    expect(program).toContain(fixture.requestId.replace(/(00)+$/, ''));
    expect(program).not.toContain(coin.nonce);
    expect(program).not.toContain(reversed(coin.nonce));
  });

  it('its identifiers are what the sponsor records before a settle reaches the node (midnight-js’s id is one of them)', () => {
    const ids = (tx.identifiers() as unknown[]).map((i) => String(i).toLowerCase());
    expect(ids).toEqual(fixture.identifiers);
    expect(ids).toContain(fixture.midnightJsTxId);
    expect(String(tx.transactionHash()).toLowerCase()).toBe(fixture.hash);
  });
});

describe('T1 on the real ledger: the temporary wallet finds such a coin only with its nonce', () => {
  const keys = temporaryWalletKeys('11'.repeat(32), 'stagenet');
  const other = temporaryWalletKeys('22'.repeat(32), 'stagenet');
  const colour = fixture.mintedCoin.color;
  const value = 1_000_000n;
  /** The output a settle makes for the temporary coin key, sealed to `epk` (the settler's choice). */
  const mintFor = (epk: string) => {
    const coin: Any = (ledger as Any).createShieldedCoinInfo(colour, value);
    const out = (ledger.ZswapOutput as Any).new(coin, 0, keys.coinPublicKey, epk);
    return { coin, offer: (ledger.ZswapOffer as Any).fromOutput(out, colour, value) };
  };
  const found = (state: Any) => [...state.coins].map((c: Any) => String(c.nonce));

  it('sealed to the temporary wallet’s own key (the sponsor’s settle): found', () => {
    const { coin, offer } = mintFor(keys.encryptionPublicKey);
    const st = new (ledger.ZswapLocalState as Any)().apply(keys.shieldedSecretKeys, offer);
    expect(found(st)).toEqual([String(coin.nonce)]);
  });

  it('sealed to another key (a griefer’s settle): NOT found; found only by watchFor with the exact coin, nonce included', () => {
    const { coin, offer } = mintFor(other.encryptionPublicKey);
    const blind = new (ledger.ZswapLocalState as Any)().apply(keys.shieldedSecretKeys, offer);
    expect(found(blind)).toEqual([]);
    // The colour and value are public; a guessed nonce does not match the commitment.
    const guess = { ...coin, nonce: '00'.repeat(32) };
    const guessed = new (ledger.ZswapLocalState as Any)()
      .watchFor(keys.coinPublicKey, guess)
      .apply(keys.shieldedSecretKeys, offer);
    expect(found(guessed)).toEqual([]);
    // Only the settler knows the nonce: with it, the wallet would find the coin.
    const watched = new (ledger.ZswapLocalState as Any)()
      .watchFor(keys.coinPublicKey, coin)
      .apply(keys.shieldedSecretKeys, offer);
    expect(found(watched)).toEqual([String(coin.nonce)]);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */

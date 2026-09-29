import { type BaseWallet, TypedDataEncoder, Wallet, hexlify, randomBytes } from 'ethers';
import { describe, expect, it } from 'vitest';

import {
  CanonicalJsonError,
  NO_SWAP,
  SPONSOR_ACTION_TYPES,
  SPONSOR_DOMAIN_NAME,
  buildSponsorActionMessage,
  canonicalJson,
  payloadHash,
  sponsorActionDigest,
  sponsorActionTypedData,
  sponsorDomain,
  verifySponsorAction,
  type SponsorActionMessage,
  type VerifySponsorActionOptions,
} from '../src/auth.js';

const NOW = 1_800_000_000;
const newNonce = () => hexlify(randomBytes(32));

/** A nonce book like the sponsor's: issued nonces, each usable once. */
function nonceBook() {
  const issued = new Set<string>();
  const used = new Set<string>();
  return {
    issue(): string {
      const n = newNonce();
      issued.add(n);
      return n;
    },
    consume: (n: string): 'ok' | 'unknown' | 'used' => {
      if (used.has(n)) return 'used';
      if (!issued.has(n)) return 'unknown';
      issued.delete(n);
      used.add(n);
      return 'ok';
    },
  };
}

async function sign(wallet: BaseWallet, message: SponsorActionMessage): Promise<string> {
  return wallet.signTypedData(sponsorDomain(), SPONSOR_ACTION_TYPES, message);
}

describe('canonical JSON and the payload hash', () => {
  it('sorts keys, drops undefined, renders bigints as strings', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined, d: 10n })).toBe(
      '{"a":[true,null,"x"],"b":1,"d":"10"}',
    );
    expect(payloadHash({ x: 1, y: 2 })).toBe(payloadHash({ y: 2, x: 1 }));
    expect(payloadHash({ x: 1 })).not.toBe(payloadHash({ x: 2 }));
  });

  it('refuses values that do not have one JSON form', () => {
    expect(() => canonicalJson({ b: new Uint8Array(2) })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalJsonError);
  });
});

describe('SponsorAction typed data', () => {
  it("names the sponsor and Sepolia, and matches ethers' own encoding", async () => {
    const wallet = Wallet.createRandom();
    const msg = buildSponsorActionMessage({
      action: 'bridge-deposit',
      network: 'stagenet',
      owner: wallet.address,
      payload: { amount: '1' },
      nonce: newNonce(),
      expiry: NOW + 60,
    });
    const td = sponsorActionTypedData(msg);
    expect(td.domain).toEqual({ name: SPONSOR_DOMAIN_NAME, version: '1', chainId: 11155111 });
    expect(td.primaryType).toBe('SponsorAction');
    expect(td.types.EIP712Domain.map((f) => f.name)).toEqual(['name', 'version', 'chainId']);
    expect(msg.swap).toBe(NO_SWAP);
    const { EIP712Domain: _d, ...types } = td.types;
    expect(sponsorActionDigest(msg)).toBe(TypedDataEncoder.hash(td.domain, types, td.message));
  });
});

describe('verifySponsorAction', () => {
  const setup = async (over: Partial<Parameters<typeof buildSponsorActionMessage>[0]> = {}) => {
    const wallet = Wallet.createRandom();
    const book = nonceBook();
    const payload = { erc20: `0x${'aa'.repeat(20)}`, amount: '1000000' };
    const message = buildSponsorActionMessage({
      action: 'bridge-deposit',
      network: 'stagenet',
      owner: wallet.address,
      payload,
      nonce: book.issue(),
      expiry: NOW + 120,
      ...over,
    });
    const signature = await sign(wallet, message);
    const options: VerifySponsorActionOptions = {
      expectedAction: 'bridge-deposit',
      network: 'stagenet',
      payload,
      now: NOW,
      maxTtlSeconds: 600,
      consumeNonce: book.consume,
    };
    return { wallet, book, payload, message, signature, options };
  };

  it('accepts a valid authorisation once', async () => {
    const { wallet, message, signature, options } = await setup();
    const r = verifySponsorAction({ message, signature }, options);
    expect(r).toMatchObject({ ok: true, signer: wallet.address });
  });

  it('refuses a replay of the same authorisation', async () => {
    const { message, signature, options } = await setup();
    expect(verifySponsorAction({ message, signature }, options).ok).toBe(true);
    expect(verifySponsorAction({ message, signature }, options)).toMatchObject({ ok: false, code: 'replayed' });
  });

  it('refuses a nonce the sponsor never issued (or forgot on restart)', async () => {
    const { wallet, payload, options } = await setup();
    const message = buildSponsorActionMessage({
      action: 'bridge-deposit',
      network: 'stagenet',
      owner: wallet.address,
      payload,
      nonce: newNonce(),
      expiry: NOW + 60,
    });
    expect(verifySponsorAction({ message, signature: await sign(wallet, message) }, options)).toMatchObject({
      ok: false,
      code: 'unknown-nonce',
    });
  });

  it('refuses the wrong signer', async () => {
    const { message, options } = await setup();
    const other = Wallet.createRandom();
    expect(verifySponsorAction({ message, signature: await sign(other, message) }, options)).toMatchObject({
      ok: false,
      code: 'wrong-signer',
    });
  });

  it('refuses an expired authorisation, and one that expires too far ahead', async () => {
    const expired = await setup({ expiry: NOW - 1 });
    expect(
      verifySponsorAction({ message: expired.message, signature: expired.signature }, expired.options),
    ).toMatchObject({ ok: false, code: 'expired' });
    const now = await setup({ expiry: NOW });
    expect(verifySponsorAction({ message: now.message, signature: now.signature }, now.options)).toMatchObject({
      ok: false,
      code: 'expired',
    });
    const far = await setup({ expiry: NOW + 601 });
    expect(verifySponsorAction({ message: far.message, signature: far.signature }, far.options)).toMatchObject({
      ok: false,
      code: 'expiry-too-far',
    });
  });

  it('refuses a body the signature does not cover', async () => {
    const { message, signature, options } = await setup();
    expect(
      verifySponsorAction(
        { message, signature },
        { ...options, payload: { ...(options.payload as object), amount: '999' } },
      ),
    ).toMatchObject({ ok: false, code: 'payload-mismatch' });
  });

  it('refuses another action, network or swap', async () => {
    const { message, signature, options } = await setup();
    expect(
      verifySponsorAction({ message, signature }, { ...options, expectedAction: 'bridge-withdraw' }),
    ).toMatchObject({
      code: 'wrong-action',
    });
    expect(verifySponsorAction({ message, signature }, { ...options, network: 'undeployed' })).toMatchObject({
      code: 'wrong-network',
    });
    expect(verifySponsorAction({ message, signature }, { ...options, expectedSwap: '11'.repeat(32) })).toMatchObject({
      code: 'wrong-swap',
    });
  });

  it('binds the swap: accepted for that swap only', async () => {
    const swap = 'cd'.repeat(32);
    const bound = await setup({ swap: `0x${swap.toUpperCase()}` });
    expect(bound.message.swap).toBe(`0x${swap}`);
    expect(
      verifySponsorAction(
        { message: bound.message, signature: bound.signature },
        { ...bound.options, expectedSwap: swap },
      ),
    ).toMatchObject({ ok: true });
    const again = await setup({ swap });
    expect(verifySponsorAction({ message: again.message, signature: again.signature }, again.options)).toMatchObject({
      ok: false,
      code: 'wrong-swap',
    });
  });

  it('refuses a tampered message (the owner is not who signed)', async () => {
    const { message, signature, options } = await setup();
    const forged = { ...message, owner: Wallet.createRandom().address };
    expect(verifySponsorAction({ message: forged, signature }, options)).toMatchObject({
      ok: false,
      code: 'wrong-signer',
    });
    const later = { ...message, expiry: String(NOW + 300) };
    expect(verifySponsorAction({ message: later, signature }, options)).toMatchObject({
      ok: false,
      code: 'wrong-signer',
    });
  });

  it('refuses a missing, malformed or garbage signature without consuming the nonce', async () => {
    const { message, options, book } = await setup();
    let consumed = 0;
    const counting = { ...options, consumeNonce: (n: string) => (consumed++, book.consume(n)) };
    expect(verifySponsorAction(undefined, counting)).toMatchObject({ code: 'malformed' });
    expect(verifySponsorAction({ message }, counting)).toMatchObject({ code: 'malformed' });
    expect(verifySponsorAction({ message, signature: `0x${'00'.repeat(65)}` }, counting)).toMatchObject({
      code: 'bad-signature',
    });
    expect(consumed).toBe(0);
  });
});

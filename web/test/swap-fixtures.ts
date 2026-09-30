// Shared fixtures for the swap tests: the mock environment on the stagenet profile and registry, a
// fake Sepolia (balances that the "transactions" move), and EIP-712 signers that sign
// deterministically (RFC 6979, like MetaMask) or not (a random nonce each time).

import { STAGENET, type SwapOffer, stagenetRegistry, deriveBook, type OfferRow } from '@evm-midnight-transparent/core';
import { secp256k1 } from '@noble/curves/secp256k1';
import { TypedDataEncoder, Wallet, getAddress, getBytes, hexlify } from 'ethers';

import type { MockSettings } from '../src/config.js';
import type { EvmPort } from '../src/swap/evm.js';
import { type MockEnvironment, createMockEnvironment } from '../src/swap/mock/index.js';
import type { SwapBackends, TypedData, TypedDataSigner } from '../src/swap/ports.js';
import { HttpSponsorApi } from '../src/swap/sponsor-client.js';
import { KernelClient } from '@evm-midnight-transparent/core';

export const network = STAGENET;
export const registry = stagenetRegistry();

export function mockEnv(settings: Partial<MockSettings> = {}): MockEnvironment {
  return createMockEnvironment({
    network,
    registry,
    settings: { stepMs: 10, scenario: {}, evmWallet: false, book: 'default', persist: false, ...settings },
  });
}

export function backendsOf(env: MockEnvironment, pollMs = 5): SwapBackends {
  return {
    kernel: new KernelClient({ baseUrl: network.zswap.kernelUrl, fetch: env.kernelFetch, retries: 0 }),
    sponsor: new HttpSponsorApi('https://sponsor.mock.invalid', { fetch: env.sponsorFetch }),
    wallet: env.wallet,
    mock: { describe: 'test' },
    pollMs,
  };
}

/** The swappable offers of the mock book, by their mock label's offer id. */
export async function swappable(env: MockEnvironment): Promise<SwapOffer[]> {
  const kernel = new KernelClient({ baseUrl: network.zswap.kernelUrl, fetch: env.kernelFetch, retries: 0 });
  const book = await kernel.allOffers();
  return deriveBook(book.offers as OfferRow[], registry).offers;
}

/** The mock book's offer "you pay 1.04 wUSDC, you receive 100 wStkA". */
export async function askOffer(env: MockEnvironment): Promise<SwapOffer> {
  const all = await swappable(env);
  const o = all.find((x) => x.pay.token.midnightName === 'wUSDC' && x.pay.amount === 1_040_000n);
  if (!o) throw new Error('no ask offer in the mock book');
  return o;
}

export class FakeSepolia implements EvmPort {
  readonly address: string;
  readonly eth = new Map<string, bigint>();
  readonly erc20 = new Map<string, bigint>();
  readonly sent: Array<{ to: string; data?: string; value?: bigint; hash: string }> = [];
  declineNext = false;

  constructor(address: string, holdings: { eth?: bigint; tokens?: Record<string, bigint> } = {}) {
    this.address = getAddress(address);
    this.eth.set(this.address.toLowerCase(), holdings.eth ?? 10n ** 18n);
    for (const t of registry.tokens)
      if (t.sepoliaAddress)
        this.erc20.set(
          `${t.sepoliaAddress.toLowerCase()}:${this.address.toLowerCase()}`,
          holdings.tokens?.[t.symbol] ?? 1_000n * 10n ** 6n,
        );
  }

  async sendTransaction(tx: { to: string; data?: string; value?: bigint }): Promise<string> {
    if (this.declineNext) {
      this.declineNext = false;
      throw Object.assign(new Error('You declined the transfer in your wallet.'), { name: 'EvmError' });
    }
    const me = this.address.toLowerCase();
    if (tx.data?.startsWith('0xa9059cbb')) {
      const to = `0x${tx.data.slice(34, 74)}`.toLowerCase();
      const amount = BigInt(`0x${tx.data.slice(74)}`);
      const k = (h: string) => `${tx.to.toLowerCase()}:${h}`;
      this.erc20.set(k(me), (this.erc20.get(k(me)) ?? 0n) - amount);
      this.erc20.set(k(to), (this.erc20.get(k(to)) ?? 0n) + amount);
    } else {
      const v = tx.value ?? 0n;
      this.eth.set(me, (this.eth.get(me) ?? 0n) - v);
      this.eth.set(tx.to.toLowerCase(), (this.eth.get(tx.to.toLowerCase()) ?? 0n) + v);
    }
    const hash = `0x${(this.sent.length + 1).toString(16).padStart(64, 'e')}`;
    this.sent.push({ ...tx, hash });
    return hash;
  }

  async ethBalance(holder: string): Promise<bigint> {
    return this.eth.get(holder.toLowerCase()) ?? 0n;
  }

  async erc20Balance(token: string, holder: string): Promise<bigint> {
    return this.erc20.get(`${token.toLowerCase()}:${holder.toLowerCase()}`) ?? 0n;
  }

  async receipt(_hash?: string): Promise<'success' | 'reverted' | null> {
    return 'success';
  }
}

/**
 * An EIP-7702-delegated account (a MetaMask smart account), as a Sepolia node treats it: ONE pending
 * transaction at a time; a second send while one is in flight is refused with the node's message
 * (plan P3 E.2 attempt 1). A transaction is mined after `pollsToMine` receipt reads.
 */
export class DelegatedSepolia extends FakeSepolia {
  inFlight: string | null = null;
  polls = 0;
  refused = 0;
  pollsToMine = 2;

  override async sendTransaction(tx: { to: string; data?: string; value?: bigint }): Promise<string> {
    if (this.inFlight) {
      this.refused++;
      throw Object.assign(new Error('in-flight transaction limit reached for delegated accounts'), { code: -32000 });
    }
    const hash = await super.sendTransaction(tx);
    this.inFlight = hash;
    return hash;
  }

  override async receipt(hash?: string): Promise<'success' | 'reverted' | null> {
    if (hash !== undefined && hash === this.inFlight) {
      this.polls++;
      if (this.polls < this.pollsToMine) return null;
      this.inFlight = null;
    }
    return 'success';
  }

  /** Mine whatever is in flight. */
  mine(): void {
    this.inFlight = null;
  }
}

export interface CountingSigner extends TypedDataSigner {
  prompts: TypedData[];
  signatures: string[];
}

/** A signer with a fixed key: RFC 6979 (deterministic) by default, or a random nonce per signature. */
export function testSigner(opts: { deterministic?: boolean; key?: string } = {}): CountingSigner & { key: string } {
  const wallet = opts.key ? new Wallet(opts.key) : Wallet.createRandom();
  const prompts: TypedData[] = [];
  const signatures: string[] = [];
  return {
    key: wallet.privateKey,
    address: wallet.address,
    prompts,
    signatures,
    async signTypedData(td: TypedData) {
      prompts.push(td);
      const { EIP712Domain: _d, ...types } = td.types as Record<string, Array<{ name: string; type: string }>>;
      let sig: string;
      if (opts.deterministic === false) {
        const digest = getBytes(TypedDataEncoder.hash(td.domain as never, types, td.message as never));
        const s = secp256k1.sign(digest, getBytes(wallet.privateKey), { extraEntropy: true });
        sig = hexlify(new Uint8Array([...s.toCompactRawBytes(), 27 + s.recovery]));
      } else {
        sig = await wallet.signTypedData(td.domain as never, types, td.message as never);
      }
      signatures.push(sig);
      return sig;
    },
  };
}

export async function waitFor<T>(
  fn: () => T | undefined | null | false,
  timeoutMs = 10_000,
  what = 'the condition',
): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

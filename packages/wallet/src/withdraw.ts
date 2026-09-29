// Bridging out: the temporary wallet's own `startWithdraw` on the ERC20 vault (G-BRIDGE B.3.1; lane
// contract `buildWithdraw`).
//
// `startWithdraw` spends the wallet's coin into the vault (the circuit's `receiveShielded`), records
// the request, and notifies the MPC through a cross-contract call to the Signet singleton's
// `signBidirectional`. The MPC then signs `transfer(dest, amount)` from the vault's Sepolia account,
// with the nonce and gas the call carries. So:
//
//   const nonce = await readVaultEvmNonce(provider.request);          // the vault account's pending nonce
//   const draft = await buildWithdraw(wallet, { colour, amount, dest, evmNonce: nonce });
//   const { tx } = await sponsor.prove('withdraw', draft.tx);         // at once: built on the live state
//   const { tx: finalized } = finalizeWithdraw(draft, tx);            // bind, check
//   await sponsor.withdraw(finalized);                                // the sponsor adds DUST, submits
//
// The call is built in the browser from the vault's LIVE state (one block, pinned: the vault's state,
// its Zswap tree and the ledger parameters, and the singleton's state for the callee), with the
// vault's compiled JS vendored in ./vendor/vault (PROVENANCE.md). No key material is needed to BUILD
// a call; the sponsor proves it with its keys. The shielded side is balanced by the temporary wallet
// alone; the DUST is the sponsor's (`balanceFinalizedTransaction` for DUST only, then merge).
//
// Ported from the G-BRIDGE gate (test/gates/bridge/temp-wallet.ts `buildStartWithdraw`), which built,
// balanced and proved the same call live; this module stops before the proof.

import {
  DEFAULT_EVM_GAS,
  type EvmGasPolicy,
  registryFor,
  type TokenRegistry,
  hexToBytes,
  walletRecipient,
} from '@evm-midnight-transparent/core';
import { getAddress } from 'ethers';

import { internalsOf, type Eip1193Request, type TempWallet } from './temp-wallet.js';
import {
  contractCalls,
  dustSpendCount,
  hasUnshieldedOffers,
  provenFromHex,
  txToHex,
  unbalancedColours,
  type AnyTransaction,
} from './tx.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export class WithdrawError extends Error {
  override name = 'WithdrawError';
  constructor(
    readonly code:
      | 'bad-input'
      | 'unknown-token'
      | 'insufficient-funds'
      | 'no-vault-state'
      | 'nothing-to-balance'
      | 'not-balanced'
      | 'unexpected-shape'
      | 'proof-mismatch'
      | 'released',
    message: string,
  ) {
    super(message);
  }
}

/** The vault's EVM account's pending nonce: the nonce the MPC's transfer will carry. Every withdrawal
 *  shares it (plan Q9 A: a collision ends in a refund, and the app retries). `request` is an EIP-1193
 *  provider's (the connected wallet on Sepolia) or `jsonRpcRequest(url)`'s. */
export async function readVaultEvmNonce(request: Eip1193Request, vaultEvmAddress: string): Promise<bigint> {
  const n = await request({ method: 'eth_getTransactionCount', params: [getAddress(vaultEvmAddress), 'pending'] });
  if (typeof n !== 'string' || !/^0x[0-9a-fA-F]+$/.test(n))
    throw new WithdrawError('bad-input', 'the RPC returned no nonce');
  return BigInt(n);
}

/** An EIP-1193 `request` over a plain JSON-RPC URL (a public Sepolia RPC). */
export function jsonRpcRequest(url: string, fetchImpl: typeof fetch = fetch): Eip1193Request {
  let id = 0;
  return async ({ method, params }) => {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (!res.ok || body.error) throw new Error(`JSON-RPC ${method}: ${body.error?.message ?? `HTTP ${res.status}`}`);
    return body.result;
  };
}

// ── The vault's compiled contract and the chain reads, loaded on first use ──

interface VaultRuntime {
  compiledContract: Any;
  ledger(state: unknown): Any;
  createUnprovenCallTxFromInitialStates: Any;
}

let runtime: Promise<VaultRuntime> | undefined;

/** The vendored vault module and midnight-js, imported on first use (a separate chunk in the app). */
function vaultRuntime(networkId: string): Promise<VaultRuntime> {
  runtime ??= (async () => {
    const [vault, compactJs, contracts] = await Promise.all([
      import('./vendor/vault/Erc20Vault/contract/index.js'),
      import('@midnight-ntwrk/compact-js'),
      import('@midnight-ntwrk/midnight-js-contracts'),
    ]);
    const { CompiledContract } = compactJs as Any;
    return {
      compiledContract: CompiledContract.make('erc20-vault', (vault as Any).Contract).pipe(
        CompiledContract.withVacantWitnesses,
      ),
      ledger: (state) => (vault as Any).ledger(state),
      createUnprovenCallTxFromInitialStates: (contracts as Any).createUnprovenCallTxFromInitialStates,
    };
  })();
  return runtime.then(async (rt) => {
    // midnight-js reads the network id from a module global when it renders the coin public key.
    const { setNetworkId } = await import('@midnight-ntwrk/midnight-js-network-id');
    setNetworkId(networkId);
    return rt;
  });
}

/** Building a call reads no key material; anything that asks for keys is a bug, so it throws. */
const NO_KEY_MATERIAL = (() => {
  const refuse = () => {
    throw new Error('the browser holds no proving or verifier keys (the sponsor proves)');
  };
  return {
    getProverKey: refuse,
    getVerifierKey: refuse,
    getVerifierKeys: refuse,
    getZKIR: refuse,
    get: refuse,
    asKeyMaterialProvider: refuse,
  };
})();

/** The chain reads a withdrawal needs: midnight-js's public data provider (or a fixture in tests). */
export interface VaultStateReader {
  queryBlock(config?: Any): Promise<{ hash: string; height: number } | null>;
  queryZSwapAndContractState(address: string, config?: Any): Promise<[Any, Any, Any] | null>;
  queryContractState(address: string, config?: Any): Promise<Any | null>;
}

const readers = new WeakMap<TempWallet, Promise<VaultStateReader>>();

async function indexerReader(wallet: TempWallet): Promise<VaultStateReader> {
  const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
  return indexerPublicDataProvider(wallet.profile.midnight.indexerUrl, wallet.profile.midnight.indexerWsUrl) as never;
}

// ── Building ─────────────────────────────────────────────────────────────────

export interface WithdrawInput {
  /** The vault token's shielded colour (64 hex). */
  colour: string;
  /** Base units; the wallet must hold at least this much of `colour`. */
  amount: bigint;
  /** The Sepolia address that receives the ERC20 (the connected EVM account). */
  dest: string;
  /** The vault EVM account's pending nonce, read right before building (`readVaultEvmNonce`). */
  evmNonce: bigint;
  /** The MPC-signed transfer's gas (default: core's DEFAULT_EVM_GAS, the G-BRIDGE values). */
  gas?: EvmGasPolicy;
}

export interface WithdrawDeps {
  /** Chain reads (default: the profile's indexer, over midnight-js). */
  reader?: VaultStateReader;
  /** The token list (default: the profile's). */
  registry?: TokenRegistry;
}

export interface WithdrawDraft {
  /** The merged unproven `startWithdraw` (the call and the wallet's shielded balancing), hex: what
   *  `/prove` receives for `purpose: "withdraw"`. */
  readonly tx: string;
  /** The request this call creates (the vault's `withdrawEventMap` key), 64 hex. */
  readonly requestId: string;
  readonly requestNonce: bigint;
  readonly colour: string;
  readonly amount: bigint;
  /** The ERC20 on Sepolia, checksummed. */
  readonly erc20: string;
  readonly dest: string;
  readonly evmNonce: bigint;
  readonly gas: EvmGasPolicy;
  /** The block whose state the call was built on. */
  readonly block: { hash: string; height: number };
  /** The vault and the Signet singleton the call names (64 hex). */
  readonly vault: string;
  readonly singleton: string;
  /** The transaction's identifiers; proving keeps them, so the proven transaction must carry them all. */
  readonly identifiers: readonly string[];
  readonly buildMs: number;
  readonly balanceMs: number;
  /** Give the booked coins back to the wallet (the withdrawal is abandoned). Idempotent. */
  release(): Promise<void>;
  readonly released: boolean;
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UINT64_MAX = (1n << 64n) - 1n;
const norm = (h: unknown) => String(h).replace(/^0x/i, '').toLowerCase();

/** The two calls a `startWithdraw` transaction holds: the vault's, then its callee's. */
export function assertWithdrawShape(tx: AnyTransaction, vault: string, singleton: string): void {
  const calls = contractCalls(tx)
    .map((c) => `${c.address}:${c.entryPoint}`)
    .sort();
  const want = [`${norm(vault)}:startWithdraw`, `${norm(singleton)}:signBidirectional`].sort();
  if (calls.length !== 2 || calls[0] !== want[0] || calls[1] !== want[1]) {
    throw new WithdrawError(
      'unexpected-shape',
      `expected the vault's startWithdraw and the singleton's signBidirectional, got ${calls.join(', ') || 'no calls'}`,
    );
  }
  if (dustSpendCount(tx) !== 0)
    throw new WithdrawError('unexpected-shape', 'the transaction spends DUST (the sponsor adds it)');
  if (hasUnshieldedOffers(tx)) throw new WithdrawError('unexpected-shape', 'the transaction moves unshielded tokens');
  const left = unbalancedColours(tx);
  if (left.length > 0)
    throw new WithdrawError('not-balanced', `the shielded side is not balanced in ${left.join(', ')}`);
}

/**
 * Build the temporary wallet's `startWithdraw` on the vault's live state and balance its shielded
 * side: an unproven transaction for `/prove`. Build it right before proving and submit at once: the
 * call is valid against the state it was built on (G-BRIDGE flag).
 */
export async function buildWithdraw(
  wallet: TempWallet,
  input: WithdrawInput,
  deps: WithdrawDeps = {},
): Promise<WithdrawDraft> {
  const { keys, opened } = internalsOf(wallet);
  const profile = wallet.profile;
  const vault = norm(profile.bridge.vaultAddress);
  const singleton = norm(profile.bridge.signetSingleton);
  if (vault === '' || singleton === '') throw new WithdrawError('bad-input', 'the network profile names no vault');
  if (!EVM_ADDRESS.test(input.dest) || /^0x0{40}$/.test(input.dest))
    throw new WithdrawError('bad-input', 'the destination is not an EVM address');
  if (input.amount <= 0n || input.amount > UINT64_MAX)
    throw new WithdrawError('bad-input', 'the amount must be between 1 and 2^64 - 1');
  if (input.evmNonce < 0n || input.evmNonce > UINT64_MAX)
    throw new WithdrawError('bad-input', 'the EVM nonce is out of range');
  const registry = deps.registry ?? registryFor(profile.name);
  const token = registry.byColour(input.colour);
  if (!token || !registry.isBridgeable(token.midnightColour) || norm(token.vault) !== vault) {
    throw new WithdrawError('unknown-token', `${input.colour} is not a token this vault bridges`);
  }
  const held = (await opened.balances())[token.midnightColour] ?? 0n;
  if (held < input.amount) {
    throw new WithdrawError(
      'insufficient-funds',
      `the wallet holds ${held} of ${token.midnightName}, less than ${input.amount}`,
    );
  }
  const gas = input.gas ?? DEFAULT_EVM_GAS;

  const t0 = performance.now();
  const rt = await vaultRuntime(profile.midnightNetworkId);
  let readerP = readers.get(wallet);
  if (deps.reader === undefined && readerP === undefined) {
    readerP = indexerReader(wallet);
    readers.set(wallet, readerP);
  }
  const reader = deps.reader ?? (await readerP!);
  // One block for everything (midnight-js createUnprovenCallTx does the same): the vault's state, its
  // Zswap tree, the ledger parameters, and the callee's state as of that block.
  const block = await reader.queryBlock();
  if (!block) throw new WithdrawError('no-vault-state', 'the indexer returned no block');
  const states = await reader.queryZSwapAndContractState(vault, { type: 'blockHash', blockHash: block.hash });
  if (!states) throw new WithdrawError('no-vault-state', `no vault state at ${vault}`);
  const [zswapChainState, contractState, ledgerParameters] = states;
  const coinNonce = crypto.getRandomValues(new Uint8Array(32));
  const call: Any = await rt.createUnprovenCallTxFromInitialStates(
    NO_KEY_MATERIAL,
    {
      compiledContract: rt.compiledContract,
      contractAddress: vault,
      circuitId: 'startWithdraw',
      args: [
        input.evmNonce,
        gas.gasLimit,
        gas.maxFeePerGas,
        gas.maxPriorityFeePerGas,
        gas.keyVersion,
        hexToBytes(token.sepoliaAddress, 20),
        input.amount,
        hexToBytes(input.dest, 20),
        { nonce: coinNonce, color: hexToBytes(token.midnightColour, 32), value: input.amount },
        walletRecipient(keys.coinPublicKey),
      ],
      coinPublicKey: keys.coinPublicKey,
      initialContractState: contractState,
      initialZswapChainState: zswapChainState,
      ledgerParameters,
    },
    keys.encryptionPublicKey,
    { publicDataProvider: reader, blockHash: block.hash },
  );
  const buildMs = performance.now() - t0;

  // The request the call creates: the vault stores it under its request nonce, then increments it.
  const next = rt.ledger(call.public.nextContractState);
  const requestNonce = BigInt(next.signetRequestNonce) - 1n;
  const ours: string[] = [];
  for (const [k, v] of next.withdrawEventMap as Iterable<[Uint8Array, Any]>) {
    if (BigInt(v.requestNonce) === requestNonce)
      ours.push(norm(Array.from(k, (b: number) => b.toString(16).padStart(2, '0')).join('')));
  }
  if (ours.length !== 1)
    throw new WithdrawError('unexpected-shape', `expected one new withdraw request, found ${ours.length}`);

  const unproven = call.private.unprovenTx;
  const t1 = performance.now();
  const balancing = await opened.wallet.balanceTransaction(keys.shieldedSecretKeys, unproven);
  const balanceMs = performance.now() - t1;
  if (balancing === undefined)
    throw new WithdrawError('nothing-to-balance', 'the shielded side needed no balancing: the coin was not spent');
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await opened.wallet.revertTransaction(balancing).catch(() => undefined);
  };
  try {
    const merged = unproven.merge(balancing);
    assertWithdrawShape(merged, vault, singleton);
    return {
      tx: txToHex(merged),
      requestId: ours[0]!,
      requestNonce,
      colour: token.midnightColour,
      amount: input.amount,
      erc20: getAddress(token.sepoliaAddress),
      dest: getAddress(input.dest),
      evmNonce: input.evmNonce,
      gas,
      block: { hash: block.hash, height: block.height },
      vault,
      singleton,
      identifiers: merged.identifiers().map(String),
      buildMs,
      balanceMs,
      release,
      get released() {
        return released;
      },
    };
  } catch (e) {
    await release();
    throw e;
  }
}

export interface FinalizedWithdraw {
  /** The proven, bound `startWithdraw`, hex: what `/withdraw` receives. */
  tx: string;
  txBytes: number;
  requestId: string;
}

/** The proven `startWithdraw` (from `/prove`) → bound and checked, ready for the sponsor's `/withdraw`:
 *  the same two calls on the same contracts, no DUST, balanced, and every identifier of the draft
 *  (proving keeps them), so it is this withdrawal and no other. */
export function finalizeWithdraw(draft: WithdrawDraft, provenHex: string): FinalizedWithdraw {
  if (draft.released) throw new WithdrawError('released', 'this withdrawal was released; build it again');
  const { tx } = provenFromHex(provenHex);
  try {
    assertWithdrawShape(tx, draft.vault, draft.singleton);
    const ids = new Set(tx.identifiers().map(String));
    const missing = draft.identifiers.filter((id) => !ids.has(id));
    if (missing.length > 0) throw new Error(`it lacks ${missing.length} of the draft's identifiers`);
  } catch (e) {
    throw new WithdrawError('proof-mismatch', `the proven transaction is not this withdrawal: ${(e as Error).message}`);
  }
  const bytes = tx.serialize();
  return { tx: txToHex(tx), txBytes: bytes.length, requestId: draft.requestId };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

# @evm-midnight-transparent/wallet

The swap's temporary Midnight wallet, in the browser. One wallet per swap: its seed is keccak256 of
the user's EIP-712 "start swap" signature (core `swap-key.ts`, spec v1), signed twice. It runs the
shielded sub-wallet only, takes the offer through the exchange's batcher, and bridges out through
the vault. The sponsor proves (it holds the key material) and pays the bridge legs' DUST.

```ts
ensureBufferGlobal(); // once, at app start

const { seed, deterministic } = await deriveSwapSeed(eip1193SwapSigner(window.ethereum, account), salt);
const wallet = await createTempWallet(seed); // shielded-only; starts syncing
await wallet.sync((p) => show(p.appliedIndex, p.latestIndex)); // ~20 s from genesis on stagenet
wallet.depositAddress; // where the user sends the ERC20 (core `swapDepositAddress`)

const sponsor = sponsorClient({ baseUrl, swapId: salt, swapToken });

// Take (the batcher pays the fee).
const take = await buildTake(wallet, offerBech32); // unproven complement of the offer
const settlement = finalizeTake(take, await sponsor.prove('take', take.tx));
const sent = await submitTake(wallet, settlement); // sent.lostRace → "Swap is not available"
if (!sent.ok) await take.release();

// Bridge out (the swap's receive leg, or Bridge back of the pay leg).
const params = await sponsor.withdrawParams('swap');
const w = await buildWithdraw(wallet, params); // on the vault's live state; prove at once
const proven = await sponsor.prove('withdraw', w.tx, { coinNonce: w.coinNonce, evmNonce: w.evmNonce });
await sponsor.withdraw(finalizeWithdraw(w, proven).tx); // a 409 with err.rebuild: release, rebuild

await wallet.close(); // stops the sync and wipes the keys
```

**The key** lives in this package's memory only (a module-private WeakMap, never on the object the
app holds); nothing is persisted or logged, and `close()` wipes it. The sponsor's proof request
carries the spend witnesses to our own proof server (spec Q3 A).

**The vault** is built in the browser from its compiled JS, vendored in `src/vendor/vault/`
(PROVENANCE.md: passport `6c7505a`, compactc 0.34.0, no keys). It and midnight-js load lazily on the
first `buildWithdraw`.

## Tests

- `test/*.test.ts` (CI): no network. A wallet whose shielded state holds chosen coins (the SDK's
  `ShieldedWallet` restored from a ledger state, `test/restored-wallet.ts`), the G-TAKE offer, the vault
  state recorded at block 679,357 and G-BRIDGE's proven `startWithdraw` (`test/fixtures/README.md`).
  `buildWithdraw` there reproduces G-BRIDGE's live request id.
- `test/browser/run.sh` (local, Docker): the module in Chromium (the Playwright image), READ-ONLY
  against stagenet: derive, sync, a take built for a live offer, a `startWithdraw` built on the live
  vault state; it checks that no seed or signature leaves the page. Nothing is proven or submitted.
- `test/proving/run.sh` (local, Docker, needs the vault's compiled keys): the `/prove` inputs proven the
  sponsor's way on the pinned proof server, and accepted by `finalizeTake` / `finalizeWithdraw`.

Vite warns that `assert` is externalised for `@subsquid/scale-codec` (a dependency of the SDK's
address-format package). The wallet builds its addresses itself (core) and does not reach that path.

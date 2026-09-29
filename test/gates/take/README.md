# G-TAKE: can a temporary Midnight wallet take a live offer, holding no DUST?

Plan 00048, gate G-TAKE (P1), **live on stagenet**. The swap's temporary Midnight wallet is derived
from an EIP-712 "start swap" signature (packages/core `swap-key.ts`), funded with exactly an
offer's wanted amount, and then takes that offer through the exchange's batcher, which pays the
fee. Result: PASS on 2026-09-29 (plan 00048, G-TAKE).

## What is here

| File | What it is |
|---|---|
| `gate.ts` | The live driver (Bun): `derive` (T.1), `fund <offerId>` (T.2), `take <offerId>` (T.3 + T.4), `measure-sync` (T.4), `status` |
| `run-gate.sh` | Host orchestration in Docker: the proof server 9.0.0-rc.6 (own writable params volume, a random free port >= 10000), one step per run, the shared funding lock around `fund` only |
| `browser/` | The T.5 harness page: `packages/wallet` bundled by Vite for the browser |
| `browser-run.ts` | The T.5 driver: headless Chromium (the Playwright image) on the gate's network; shielded-only sync + one proof request to the proof server (CORS) |

The reusable parts live in the packages: `packages/core/src/swap-key.ts` (the derivation spec) and
`packages/wallet` (keys, the shielded-only wallet, server proving, `buildTake`, `ensureBufferGlobal`).

## Running it

Never in CI: it spends from live wallets. Secrets are bind-mounted read-only and read in-process;
nothing secret is printed or written.

```sh
export GATE_EVIDENCE_DIR=<public evidence folder>
test/gates/take/run-gate.sh derive                 # sign twice, derive, print public keys
test/gates/take/run-gate.sh fund <offerId>         # takes ~/.stagenet-offer-ladders/funding.lock
test/gates/take/run-gate.sh take <offerId>
test/gates/take/run-gate.sh measure-sync
test/gates/take/run-gate.sh browser
test/gates/take/run-gate.sh down
```

The gate funds and takes ONE offer: its public state (the swap salt, the offer, the funding
transaction) is kept in `GATE_STATE_DIR` (default `~/.config/aa-00048`), and `fund`/`take` refuse
to run twice.

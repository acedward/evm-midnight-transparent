# Live end-to-end runs (plan 00048 P3)

The swap, through the real UI of the deployed bundle (`deploy/compose.yml`), on Midnight stagenet
and Sepolia, within the owner's caps (Q8 A: at most 100 DUST and 0.02 Sepolia ETH per run, one
small ladder offer). Never run by CI.

| Run | What | Spec phase |
|---|---|---|
| E.2 + E.4 | a full swap of one live offer; the page is closed during the bridge-in and a new page resumes it by signing again | `e2` |
| E.3 | a swap whose offer a competitor wallet takes during the bridge-in: "Swap is not available", then Bridge back | `e3` |

```sh
test/live/run-live.sh env                    # ports, image tag, the secret files' paths
test/live/run-live.sh preflight              # node version, Sepolia balances, vault EVM gas, the book
test/live/run-live.sh build && test/live/run-live.sh keys
test/live/run-live.sh competitor-fund <bid>  # E.3 only, BEFORE up (the gate takes the funding lock itself)
test/live/run-live.sh up                     # takes the funding lock, holds it until stop/down
test/live/run-live.sh phase e2 <offerId>     # E.2 + E.4
test/live/run-live.sh temp-check <salt> e2-07-temp-wallet  # the record's salt (P4.2-fix: not its id); add 1 for P3's swaps
test/live/run-live.sh phase e3 <bid>         # E.3; when $STATE/e3-ready.json appears:
test/live/run-live.sh competitor-take <bid>
test/live/run-live.sh down                   # compose down -v, lock released
```

Secrets are files, read in-process only: the sponsor's seed (`.stagenet`, shared, only under
`~/.stagenet-offer-ladders/funding.lock`) is a Compose secret of the sponsor; the test EVM user's key
(`.sepolia`) is mounted read-only into the Playwright runner, whose injected EIP-1193 wallet
(`test/e2e/test-wallet.ts`, LIVE mode) signs and broadcasts on Sepolia. The page never sees a key.
Evidence (public values and screenshots) goes to the plan's `evidence/…/p3/` folder.

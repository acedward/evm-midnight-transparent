# The sponsor

A small service (Bun + Hono) that makes a swap possible for a user who holds no DUST: its own
Midnight wallet pays the fees of each swap's bridge legs, it drives the vault's MPC relayer, and it
proves the swap's transactions on its own proof server. It never receives a seed or a secret key:
the temporary wallet lives in the user's browser (`packages/wallet`), and the sponsor only sees its
public keys and the transactions it is asked to prove or pay for.

## What it does

| Step | Who | What the sponsor does |
|---|---|---|
| Open | the page, with ONE EIP-712 signature (`SponsorAction` "open-swap") | checks the offer (live, far from expiry, exactly the swap's two legs in the kernel's view AND in the maker's transaction), computes the deposit address from the temporary coin key, sizes the sweep gas, answers a bearer token |
| Deposit | server-driven | watches the deposit address until it holds the pay amount of the ERC20 and the sweep ETH, then `startDeposit` (recipient = the temporary coin key), the relayer (MPC signature, broadcast, Sepolia finality, attestation), `completeDeposit` with the temporary encryption key mapped, so the minted coin is sealed to the temporary wallet |
| Take | the browser (the batcher pays its fee) | proves the take's balancing transaction if and only if it balances THIS swap's offer |
| Withdraw / Bridge back | the browser builds and binds `startWithdraw`; the sponsor pays | proves it if and only if its calls are exactly the `startWithdraw` the sponsor rebuilds from the swap's own values and its coins are exactly the wallet's coin in and the vault's coin out (at most one change coin); `/withdraw` must carry that exact transaction; then, in the ONE withdrawal lane (the vault account's EVM nonce), adds DUST, submits, and releases the lane (the start's record now holds the nonce); the relayer (re-broadcasting until mined, every wait bounded) and `completeWithdraw` (or `refundWithdraw`) follow; a refund or a failed start sets `withdrawal.retry` |
| Stale requests | the sponsor | resumes its own swaps' requests after a restart, and drives again any that stalled (capped per day, never below a DUST reserve); a transfer signed but stuck unmined is replaced by the next withdrawal's (`deploy/RUNBOOK.md` 13.7) |
| Spending controls | the sponsor | new swaps per address per day, swaps waiting for funds overall, a daily DUST budget over paid and in-flight legs; recoverable failures (`failed.recoverable`) revive on a re-open |

The API (paths, bodies, the state machine, error codes) is `packages/core/src/swap-api.ts`, with a
fetch client in `packages/core/src/sponsor-client.ts`; the plan's "Lane contracts" section explains
the choices. The refusal rules are `src/validate/rules.ts`.

## Running it

```sh
# 1. The vault key directory (compiled vault + keys, verified against the chain). Either compile it:
docker build -f deploy/vault-keys.Dockerfile -t evm-midnight-transparent/vault-keys .
docker volume create emt-vault-keys
docker run --rm -v emt-vault-keys:/app/vault-managed evm-midnight-transparent/vault-keys
#    ...or import a directory built elsewhere (it is verified the same way):
docker run --rm -v emt-vault-keys:/app/vault-managed -v "$HOME/.cache/aa-00048/vault-managed:/import:ro" \
  evm-midnight-transparent/vault-keys import

# 2. The sponsor (the proof server is 9.0.0-rc.6; the secrets are files, mounted read-only).
docker build -f deploy/sponsor.Dockerfile -t evm-midnight-transparent/sponsor .
docker run -d --name emt-sponsor -p 8080:8080 \
  -v emt-vault-keys:/app/vault-managed:ro -v emt-sponsor-data:/data \
  -v /etc/emt/secrets:/run/secrets:ro \
  -e SPONSOR_NETWORK=stagenet -e SPONSOR_ENABLED=true -e SPONSOR_DEDICATED_WALLET=true \
  -e SPONSOR_SEED_FILE=/run/secrets/sponsor-seed -e SEPOLIA_RPC_URL_FILE=/run/secrets/sepolia-rpc-url \
  -e MIDNIGHT_PROOF_SERVER_URL=http://proof-server:6300 -e SPONSOR_CORS_ORIGINS=https://swap.example \
  evm-midnight-transparent/sponsor
```

`GET /v1/health` says whether the vault keys matched the chain (`bridge.keysVerified`), the
sponsor's DUST, the proof server, the lanes, the swaps by state, the MPC's recent behaviour and the
stale closer.

Read-only checks of a key directory (they query the indexer; nothing is proven or sent):

```sh
bun sponsor/src/tools/vault-keys.ts verify vault-managed         # verifier keys = the chain's
bun sponsor/src/tools/vault-keys.ts rebuild-check vault-managed  # the startWithdraw rebuild is deterministic
```

## Configuration

Secrets are never plain environment values in production: pass the PATH of a file.

| Variable | Default | Meaning |
|---|---|---|
| `SPONSOR_NETWORK` | (required) | `stagenet` or `undeployed` |
| `SPONSOR_SEED_FILE` | | the sponsor wallet's seed (hex, a BIP-39 mnemonic, or a `WALLET=` line). A plain `SPONSOR_SEED` is refused unless `SPONSOR_NETWORK=undeployed` |
| `SEPOLIA_RPC_URL_FILE` | | a Sepolia JSON-RPC URL (usually keyed); without it the bridge is off. A plain `SEPOLIA_RPC_URL` is refused unless `SPONSOR_NETWORK=undeployed` |
| `SPONSOR_ENABLED` | `false` | open the sponsor wallet (needs the seed) |
| `SPONSOR_DEDICATED_WALLET` / `SPONSOR_FUNDING_LOCK_FILE` | | on a live network: the seed is this sponsor's alone, or the shared lock file to take first |
| `SPONSOR_FEE_BLOCKS_MARGIN` | `20` | the wallet SDK's fee margin in blocks |
| `SPONSOR_DUST_LOW_SPECKS` | `10^16` | below this (10 DUST), new swaps are refused and health degrades |
| `SPONSOR_HOST`, `SPONSOR_PORT` | `0.0.0.0`, `8080` | |
| `SPONSOR_CORS_ORIGINS` | (none) | the web's origins, comma-separated |
| `SPONSOR_TRUST_PROXY` | `false` | rate-limit by the last `X-Forwarded-For` hop (behind our own proxy only) |
| `SPONSOR_DATA_DIR` | `sponsor-data` | where the swaps are kept (`/data` in the image; `:memory:` for tests) |
| `SWAP_RETAIN_DAYS` | `30` | finished swaps are dropped after this; swaps in flight never are |
| `VAULT_MANAGED_DIR` | `vault-managed` | the vault key directory, under the repository root (`/app/vault-managed` in the image); its `Erc20Vault` and `SignetSigner` `contract/index.js` must be the pinned build (`src/bridge/vault.ts` `VAULT_MODULE_SHA256`) or the bridge stays off |
| `MIDNIGHT_PROOF_SERVER_URL` | `http://proof-server:6300` | the sponsor's proof server |
| `PROOF_SERVER_EXPECTED_VERSION` | `9.0.0-rc.6` | health reports a mismatch |
| `PROOF_TIMEOUT_SECONDS` | `900` | per proof |
| `APP_NAME` | `EVM Midnight Swap` | the name `/v1/config` serves (plan Q10) |
| `SWAP_MIN_OFFER_TTL_SECONDS` | `1800` | a new swap's offer must expire at least this far ahead |
| `SWAP_MAX_ACTIVE_PER_OWNER` | `3` | swaps in progress per EVM address |
| `SWAP_MAX_PER_OWNER_PER_DAY` | `10` | new swaps per EVM address in any 24 hours (`429 too-many-swaps`) |
| `SWAP_MAX_UNFUNDED` | `100` | swaps waiting for funds that received nothing, all users (`503 sponsor-busy` past it) |
| `SPONSOR_DAILY_DUST_BUDGET` | `500` | DUST the sponsor may pay in any 24 hours, counting the legs still in flight (`503 sponsor-budget` for new swaps and re-arms past it); `0`: none |
| `SWAP_DUST_PER_START_SPECKS`, `SWAP_DUST_PER_SETTLE_SPECKS` | 2.2 and 0.4 DUST | the budget's estimate of one paid start and one paid settle |
| `SWAP_PROOFS_PER_SWAP` | `12` | proofs per swap and purpose (take; withdraw, renewed per attempt after a refund or failed start) |
| `SWAP_PROOFS_TOTAL_PER_SWAP` | `48` | proofs in a swap's whole life |
| `SWAP_FUNDS_WAIT_SECONDS` | `10800` | an `awaiting_funds` swap that received nothing fails after this (recoverable: a re-open resumes it); a funded one never fails for its age |
| `SWAP_FUNDS_WAIT_PARTIAL_SECONDS` | `86400` | ... one that received part of the token |
| `SWAP_RETAIN_UNFUNDED_DAYS` | `2` | never-funded failed swaps are dropped after this, once their address reads empty |
| `DEPOSIT_POLL_SECONDS` | `15` | how often a deposit address is read at first (then every minute, and every 5 minutes after an hour, while nothing arrives) |
| `DEPOSIT_MAX_ATTEMPTS` | `3` | `startDeposit` attempts per swap (a never-executed sweep is retried) |
| `DEPOSIT_MAX_REARMS` | `3` | how often a re-open may re-arm a failed deposit (`deposit-attempts`, `deposit-returned-false`) with a new `startDeposit` |
| `SWEEP_GAS_LIMITS` | 65,000 for each token | per-token overrides, `USDC:70000,stkA:60000` (`src/swaps/sweep-gas.ts`) |
| `SWEEP_MAX_WEI` | `5·10^15` | refuse new swaps while the sweep would cost more ETH (a gas spike); also caps the fee a sweep signs |
| `BRIDGE_EVM_GAS_LIMIT`, `BRIDGE_EVM_MAX_FEE_PER_GAS`, `BRIDGE_EVM_MAX_PRIORITY_FEE_PER_GAS` | 100,000, 10 gwei, 1 gwei | the withdrawal's gas (paid by the vault's EVM account); the max fee here is a floor: each withdrawal signs max(it, 2 × the live base fee + tip), sized at withdraw-params |
| `BRIDGE_EVM_MAX_FEE_CAP_WEI` | `10^11` (100 gwei) | above it, withdrawals are refused until gas is cheaper |
| `WITHDRAW_STUCK_AFTER_SECONDS`, `WITHDRAW_UNSIGNED_STALE_SECONDS` | `1800`, `7200` | a transfer signed but unmined this long (with the base fee above its cap), or a start unsigned this long, is stuck: the next withdrawal takes its nonce |
| `VAULT_GAS_LOW_WEI` | `2·10^15` | health degrades when the vault's EVM account holds less |
| `STALE_CLOSER_ENABLED` | `true` | |
| `STALE_CLOSER_INTERVAL_SECONDS`, `STALE_AFTER_SECONDS` | `300`, `900` | scan period; how long a request must be idle |
| `STALE_CLOSER_MAX_PER_DAY` | `48` | re-drives paid for in any 24 hours |
| `STALE_CLOSER_MIN_DUST_SPECKS` | 2 × the low level | the closer spends nothing below this |
| `RATE_LIMIT_*` | | per minute: `READS` 240, `HEALTH` 60, `NONCES` 30, `OPENS` 10 (per IP) and `OPENS_PER_OWNER` 5, `PROVES` 20 (per IP) and `PROVES_PER_SWAP` 6, `WRITES` 20 |
| `AUTH_MAX_TTL_SECONDS`, `AUTH_NONCE_TTL_SECONDS` | `600`, `600` | the open-swap signature's expiry cap; how long a nonce lives |
| `SPONSOR_MAX_BODY_BYTES` | `2097152` | request body limit |
| `MIDNIGHT_*`, `ZSWAP_*`, `BRIDGE_*` | the network profile | endpoint and contract overrides |
| `LOG_LEVEL` | `info` | logs are JSON, with every secret redacted by key and by value |

## Tests

`bun run test` (or `scripts/docker-check.sh all`) runs everything against fakes (`test/fakes.ts`):
the open-swap signature and the bearer token, every take and withdraw refusal rule (on summaries,
through the routes, and over real ledger-v9 transactions), the state machine, the server-driven
deposit, the withdrawal lane (no two starts share a nonce), refunds, Bridge back, restarts, the
stale closer and the sweep sizing, and the security fix pass (`test/fix-pass.test.ts`, one block per
audit row; `test/relay-loop.test.ts`, the bounded relayer on a virtual clock). Nothing in them
touches a network.

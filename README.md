# evm-midnight-transparent

Swap on Midnight from an EVM wallet, with no Midnight wallet of your own.

A user connects an EVM wallet on Sepolia, picks a live offer from the ZSwap exchange on Midnight
stagenet, and signs. The app then:

1. creates a temporary Midnight wallet for this swap, in the browser;
2. bridges in exactly the amount the offer wants (Sepolia ERC20 to the Midnight vault);
3. takes the offer on Midnight;
4. bridges out what the offer gave, back to the user's EVM address.

A small sponsor service pays the Midnight fees of the bridge legs. It never holds a user's keys.

Status: work in progress. Test networks only (Midnight stagenet and Ethereum Sepolia); nothing
here carries real value.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

## How this branch works

`00048-evm-midnight-transparent` is the master branch of this project's single pull request into
`main`. Work is done on short-lived branches whose temporary pull requests target this branch,
and each is merged in with a merge commit once its checks are green. The master pull request
stays a draft until the work is complete; the owner merges it.

## Repository layout

| Path | What it holds |
|---|---|
| `packages/core` | Shared, environment-neutral TypeScript: network profiles, the token registry (every token the vault bridges; no token is special), amount maths, the exchange client and the swappable-offer book, the batcher envelope, the bridge's wire types and preflights, and the sponsor's authorisation and API types. |
| `packages/core/src/tokens/deployments` | The vault's deployment records, vendored byte for byte (`PROVENANCE.md`). |
| `sponsor/` | The sponsor service (Bun + Hono): open-swap authorisation, the server-driven deposit, the proof proxy with its refusal rules, the withdrawal lane, the relayer, the stale closer, its wallet and configuration with `*_FILE` secrets. See `sponsor/README.md`. |
| `deploy/` | The sponsor's image and the vault key job (compactc 0.34.0, verified against the chain). |
| `web/` | The web app (Vite + React): the design system, the shell, the EVM wallet connection, the browser store and the Local data tab. |
| `scripts/` | The Docker check runner, the sponsor start-up smoke and the secret scan. |

Much of this is copied from MN Bank (`acedward/passport-evm-dapp` @ `911647b`), without its
Passport parts; see `NOTICE`.

## Development

Requirements: Bun 1.3.11 and Node 24 (for the test runner), or Docker only.

```sh
bun install
bun run check                        # format, lint, typecheck, unit tests
bun run build:web
bun scripts/sponsor-smoke.ts         # the sponsor starts and serves
```

To run everything in Docker instead (`node_modules` stays in a Docker volume):

```sh
scripts/docker-check.sh all          # install, check, web build, sponsor start-up
scripts/docker-check.sh down         # remove the container and volumes
```

## Checks and the secret scan

CI (`.github/workflows/ci.yml`) runs on every push and pull request: format, lint, typecheck, unit
tests, the web build, the sponsor start-up check, and the secret scan over the built bundle and
over the full history.

This repository is public. Run the secret scan before every push:

```sh
SECRET_SCAN_FILES=/path/to/secret-file:/path/to/another bash scripts/secret-scan.sh
```

It runs gitleaks (the default rules plus wallet-secret, mnemonic, keyed-RPC-URL and
labelled-private-key rules, each proven by a self-test on random fakes) over the whole history
and the working tree. With `SECRET_SCAN_FILES`, it also reads those files in-process and checks
that no 3-word window of a mnemonic and no key's hex appears anywhere in the tree or the
history. It never prints a secret.

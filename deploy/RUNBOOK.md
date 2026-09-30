# EVM Midnight Swap: operator runbook (stagenet)

This runbook deploys and runs EVM Midnight Swap on Midnight **stagenet** with Ethereum **Sepolia**.
Both are test networks: nothing here carries real value. Every command runs from the repository root
unless it says otherwise.

There are two ways to deploy it:

| Layout | Where | Status |
|---|---|---|
| **The Compose bundle** (`deploy/compose.yml`): web, sponsor, its own proof server, the vault key job | Any Linux host with Docker | **Tested live** (plan 00048 P3, 2026-09-29/30): two complete runs through the real UI on stagenet and Sepolia, a swap with a resume and a "Swap is not available" → Bridge back, with every hash recorded. The runs used Docker Desktop on macOS |
| **Native, next to MN Bank** (`deploy/SYSTEMD.md`): systemd units, MN Bank's proof server shared, an nginx site | The host that already runs MN Bank natively | **Not run on a host yet** (the unit files and the nginx site were checked in containers; see that file's last section) |

Sections 4 to 14 apply to both. Where the commands differ, `deploy/SYSTEMD.md` gives the native ones.

## Contents

1. [What runs](#1-what-runs)
2. [Prerequisites and sizing](#2-prerequisites-and-sizing)
3. [First deployment (Docker Compose)](#3-first-deployment-docker-compose)
4. [The sponsor wallet](#4-the-sponsor-wallet)
5. [The Sepolia RPC file](#5-the-sepolia-rpc-file)
6. [The vault key directory](#6-the-vault-key-directory)
7. [Gas for withdrawals: the vault's EVM account](#7-gas-for-withdrawals-the-vaults-evm-account)
8. [Health monitoring](#8-health-monitoring)
9. [The withdrawal lane, and MN Bank on the same vault (Q9)](#9-the-withdrawal-lane-and-mn-bank-on-the-same-vault-q9)
10. [Capacity and limits](#10-capacity-and-limits)
11. [What users must know](#11-what-users-must-know)
12. [Known limits](#12-known-limits)
13. [Incidents](#13-incidents)
14. [Start, stop, upgrade and re-pin](#14-start-stop-upgrade-and-re-pin)
15. [Reference: pins and addresses](#15-reference-pins-and-addresses)
16. [What was tested](#16-what-was-tested)

## 1. What runs

A swap: the user's EVM wallet signs, a **temporary Midnight wallet** is derived in the browser from
that signature (one per swap, kept in memory only), the offer's wanted amount is bridged in through
the ERC20 vault, the page takes the offer through the exchange's batcher (which pays that fee), and
the received token is bridged back to the user's EVM address. The **sponsor** pays the Midnight fees
(DUST) of the four bridge legs and proves for the page. It never receives a seed or a secret key.

`deploy/compose.yml` runs four services. They start in this order.

| Service | What it does | Public? | Holds a secret? |
|---|---|---|---|
| `vault-keys` | A one-shot job. It compiles the ERC20 vault and the Signet singleton with compactc 0.34.0 from the pinned sources, with their prover keys, verifies every bridge circuit's verifier key against the chain, and writes the `vault-keys` volume. Then it exits. Later starts only re-verify (a few seconds). A failure keeps the sponsor down. | No | No |
| `proof-server` | `midnightntwrk/proof-server:9.0.0-rc.6`, pinned by digest. It proves the sponsor's vault calls, the sponsor wallet's DUST spends, and the swaps' takes and withdrawals. Only the sponsor reaches it. | No | No |
| `sponsor` | Pays the bridge legs' DUST from its own wallet, drives each deposit (server-side, after the user's funds arrive), proves for the page (only this swap's take or this swap's withdrawal), runs the one withdrawal lane, the MPC relayer and the stale closer. It keeps each swap's public record in the `sponsor-data` volume. | Only through `web`, under `/sponsor/` | The sponsor seed and the Sepolia RPC URL, as files |
| `web` | The static site on an unprivileged nginx. It passes `/sponsor/` to the sponsor, so the site and the sponsor share one origin (no CORS). It writes the site's `config.json` at start. | Yes, behind your TLS proxy | No |

Volumes:

| Volume | Size | Content |
|---|---|---|
| `<project>_vault-keys` | about 1 GB | The compiled vault and singleton with their prover and verifier keys, and the check report `.vault-keys.json`. Public artefacts. |
| `<project>_proof-params` | about 0.3 GB | The proof server's public parameters and its built-in zswap and DUST keys, fetched at its first start. |
| `<project>_sponsor-data` | kilobytes | `swaps.json`: every swap's public record (ids, EVM address, public keys, deposit address, request ids, hashes, stages). The bearer tokens are kept as SHA-256. **Back it up** (section 14.1). |

Services you do not run: the stagenet ZSwap kernel (`https://stagenet.api-zswap.zkdojo.com`), which
the browser reads for offers, and the batcher (`https://stagenet.batcher-zswap.zkdojo.com`), to which
the browser submits takes. Sig Network's MPC signs and attests the vault's Sepolia transfers.

## 2. Prerequisites and sizing

**Software**: Linux with Docker Engine 25 or newer and the Compose plugin (v2.24 or newer), git and
`curl`. A TLS reverse proxy (Caddy, nginx, a tunnel) for the public site.

**Memory**:

| What | Memory |
|---|---|
| Proof server | Its limit is `PROOF_SERVER_MEM_LIMIT=10g`. The sponsor proves one transaction at a time; the largest vault circuits are k=16 (prover keys up to 117 MB), so a proof needs a few GB, far less than MN Bank's k=18 (about 8 GB). Not measured separately |
| Sponsor | Limit `SPONSOR_MEM_LIMIT=4g`; both live runs stayed under it. It streams prover keys to the proof server (MN Bank's provider), so a proof adds little |
| Web | under 50 MB; limit 256 MB |
| Key job, once, while it compiles | limit `VAULT_KEYS_JOB_MEM_LIMIT=8g` |

Plan for about **8 GB of RAM** for the bundle alone (an estimate: the live runs did not measure
memory).

**Disk**: about 5 GB free. The images take about 1.8 GB (web 122 MB, sponsor 776 MB, key job 873 MB,
as built in P3), the key volume about 1 GB.

**CPU**: 4 cores recommended. On the P3 test host a take proved in about 2 s and a withdrawal in
about 5 to 8 s.

**Network**: the host needs outbound HTTPS and WSS to:

- `rpc.stagenet.shielded.tools` (node) and `indexer.stagenet.shielded.tools` (indexer);
- `stagenet.api-zswap.zkdojo.com` (kernel: offer checks) and `stagenet.batcher-zswap.zkdojo.com` (batcher: a health probe);
- `storage.googleapis.com` (Sig Network's MPC output cache);
- `srs.midnight.network` (public parameters for the key job and the proof server);
- your Sepolia RPC provider;
- at build time only: `registry.npmjs.org`, `github.com` (compactc and the vault's pinned sources) and Docker Hub.

Users' browsers talk to your site, to the kernel (offers), to the indexer (their temporary wallet's
sync), to the batcher (the take), and to their own EVM wallet.

**Next to MN Bank**: do not run this bundle on MN Bank's host. It would start a second proof server
(its limit is 10 GB) beside MN Bank's. Use `deploy/SYSTEMD.md`, which shares MN Bank's proof server.

## 3. First deployment (Docker Compose)

Do these steps in order. Sections 4 to 6 explain each one.

```sh
# 1. The code.
git clone https://github.com/acedward/evm-midnight-transparent.git emt
cd emt
git checkout <release commit>

# 2. A private directory for the two secret files (sections 4 and 5 fill it). The sponsor runs as
#    uid 1000 (the image's `bun` user) and must be able to read them.
sudo install -d -m 700 -o 1000 -g 1000 /srv/emt/secrets

# 3. The settings.
cp deploy/.env.example deploy/.env
# Edit deploy/.env: at least SPONSOR_SEED_HOST_FILE and SEPOLIA_RPC_URL_HOST_FILE (the defaults
# already point at /srv/emt/secrets). Keep comments on their own lines.

# 4. Build the three images (a few minutes).
docker compose -f deploy/compose.yml build

# 5. The sponsor wallet (section 4) and the Sepolia RPC file (section 5).

# 6. The vault key directory (section 6): a few minutes the first time. Watch it finish.
docker compose -f deploy/compose.yml up vault-keys

# 7. Start everything.
docker compose -f deploy/compose.yml up -d
docker compose -f deploy/compose.yml ps        # web shows "healthy"; the sponsor becomes healthy once it serves
curl -s http://127.0.0.1:18091/v1/health        # section 8; "ok" once the sponsor wallet has synced (about 2 minutes)

# 8. Check the vault's gas (section 7).
```

Then put your TLS proxy in front of `127.0.0.1:18090` (`WEB_HOST_PORT`). With Caddy:

```
swap.example.com {
    reverse_proxy 127.0.0.1:18090
}
```

The web container believes the `X-Forwarded-For` header only from the addresses in
`WEB_TRUSTED_PROXIES`. The default (loopback and the private ranges) fits a proxy on the same host.
If your proxy runs elsewhere, put its address there. If this is wrong, every user shares one
rate-limit bucket at the sponsor.

Open the site. It should list the live offers whose two legs the vault bridges. `/config.json` must
say `{"network":"stagenet","sponsorUrl":"/sponsor"}`, and `/sponsor/v1/config` must name the vault
`7771c9e5…` and the signing domains "EVM Midnight Swap" and "EVM Midnight Swap Sponsor".

To serve a full site configuration instead (for example a Midnight explorer URL, question Q11:
`{"network":"stagenet","sponsorUrl":"/sponsor","overrides":{"midnight":{"explorerUrl":"https://…"}}}`),
mount a file at `/etc/emt/config.json` in the `web` service with a Compose override file; it is then
served as is. Never put a `mock` block in a deployed `config.json`: it runs the whole app against
in-page mocks.

**The site's Content-Security-Policy.** The web container sends a strict policy by default
(`deploy/web/csp.sh`): scripts only from the site (plus `'wasm-unsafe-eval'` for the ledger's
WebAssembly), no inline script, no eval, no framing, no forms, and network access only to the site
itself (with its `/sponsor` proxy), the exchange's kernel and batcher, and the Midnight indexer and
node of the network. It was checked in Chromium against the built image
(`bash deploy/web/csp-browser-check.sh`: zero violations, every browser spec passes). Leave
`WEB_CONTENT_SECURITY_POLICY` empty to keep it. If a mounted `config.json` points the page at other
hosts, add their `https://` or `wss://` origins to `WEB_CSP_CONNECT_EXTRA` (comma-separated), or the
browser blocks them. `WEB_CONTENT_SECURITY_POLICY=off` sends none; any other value is sent verbatim.
**HSTS belongs to your TLS proxy**: the web container serves plain HTTP on 127.0.0.1 and cannot set it.
With Caddy, add `header Strict-Transport-Security "max-age=31536000"` to the site block (Caddy
already redirects HTTP to HTTPS).

## 4. The sponsor wallet

The sponsor pays every DUST fee of every swap's bridge legs from one wallet: the sponsor wallet.
Users never need DUST, and the batcher pays for the takes.

### 4.1 Its own seed: never MN Bank's, never the shared `.stagenet` wallet

Create a new wallet that only this sponsor uses, and fund it from the owner's `.stagenet` wallet.

- **One wallet process per seed.** The sponsor keeps its wallet open all the time. A second process
  on the same seed (MN Bank's relay, a ladder tool, a test run) knocks the first one off, and both
  pick the same DUST coins and fail each other's transactions.
- **MN Bank's relay holds its own seed open all the time**, so its seed can never be shared with
  this sponsor, even on the same host.
- **The sponsor refuses to open a live wallet** unless the seed is declared its own
  (`SPONSOR_DEDICATED_WALLET=true`) or a shared lock file is named (`SPONSOR_FUNDING_LOCK_FILE`, for
  test runs only). Declare it dedicated only when it is.
- **A smaller blast radius and clear accounting**: a compromised server loses only what you put in
  this wallet, and its balance is exactly what the swaps have cost.

### 4.2 Create it

The sponsor image carries the tool. It writes a new 24-word mnemonic to a file with mode 600 and
never overwrites an existing file. It prints only the public NIGHT address.

```sh
docker run --rm --user 1000:1000 -v /srv/emt/secrets:/out \
  evm-midnight-transparent/sponsor:local bun sponsor/src/tools/sponsor-wallet.ts new --out /out/sponsor.seed --network stagenet
```

Output:

```json
{ "wrote": "/out/sponsor.seed", "mode": "600", "network": "stagenet",
  "nightAddress": "mn_addr_stagenet1…" }
```

Back up `sponsor.seed` like any wallet seed. To print the address again:

```sh
docker run --rm --user 1000:1000 -v /srv/emt/secrets/sponsor.seed:/s/seed:ro \
  evm-midnight-transparent/sponsor:local bun sponsor/src/tools/sponsor-wallet.ts address --seed-file /s/seed --network stagenet
```

The seed file may also hold a hex seed or one `WALLET=` / `SEED=` / `MNEMONIC=` line.

### 4.3 Fund it and register its NIGHT for DUST

DUST is not transferred: registered NIGHT **generates** it. The live stagenet parameters (read on
2026-09-27; `sponsor-wallet status` prints them live) are about **0.714 DUST per registered NIGHT per
day**, up to a cap of **5 DUST per NIGHT**, reached in 7 days.

1. **Send NIGHT** to the sponsor's `nightAddress` from `.stagenet`, the way you usually move stagenet
   NIGHT. With the owner's tooling, take `~/.stagenet-offer-ladders/funding.lock` first, as usual.
   Send it in **several transfers** (for example 4 or 5): each NIGHT coin generates its own DUST coin,
   and a DUST coin is booked whole while a transaction that spends it is pending (section 4.5).
2. **Register the NIGHT for DUST generation.** One transaction; its fee comes from the DUST the NIGHT
   generates first, so the tool waits (a few minutes) until there is enough. The sponsor must be
   stopped, because the tool opens the same wallet:

   ```sh
   docker compose -f deploy/compose.yml stop sponsor
   docker compose -f deploy/compose.yml up -d proof-server
   docker compose -f deploy/compose.yml run --rm --no-deps sponsor bun sponsor/src/tools/sponsor-wallet.ts register-dust
   docker compose -f deploy/compose.yml start sponsor
   ```

   The tool refuses while the sponsor holds the wallet. Run `register-dust` again after every NIGHT
   top-up: only registered NIGHT generates DUST.
3. **Check it**: the same three lines with `status` instead of `register-dust`. It prints the NIGHT
   balance, how much is registered, the DUST balance, and the ceiling and daily income. While the
   sponsor runs, `/v1/health` shows the DUST balance without stopping anything (section 8).

`register-dust` follows the recipe MN Bank's tool and the Offer Files ladder tools use on stagenet
with the same wallet SDK. It was not run while this bundle was built (the live runs used a funded
wallet); watch the first run.

### 4.4 What the sponsor spends

Measured at the default fee margin (`SPONSOR_FEE_BLOCKS_MARGIN=20`; the wallet declares about 2.5
times each fee):

| Action | DUST from the sponsor |
|---|---|
| One complete swap: `startDeposit`, `completeDeposit`, `startWithdraw`, `completeWithdraw` | **4.66** (P3 E.2) |
| A swap that ends in Bridge back (the same four legs) | **4.70** (P3 E.3) |
| A refunded withdrawal and its retry (section 9) | about 2.5 more (a `startWithdraw` and a `refundWithdraw`; estimated) |
| A deposit whose sweep never ran: `abandonDeposit`, then a new start | about 2.5 more (estimated) |
| The take | 0 (the batcher pays it) |
| A stale closer re-drive (section 13.3) | the settle it ends with, a fraction of a DUST |

Sizing example: 200 registered NIGHT generate about 143 DUST a day (about 30 swaps a day), with a
ceiling of 1,000 DUST.

**The daily budget** (`SPONSOR_DAILY_DUST_BUDGET`, default 500 DUST; 0 turns it off) caps what anyone
can make the sponsor spend. A swap's DUST is committed **when its funds are all at the deposit
address**, not when it opens: a swap that has received nothing costs the budget nothing, so opening
many swaps cannot use it up. A funded swap whose legs, plus what the last 24 hours' legs cost, plus
what the swaps in flight still need, would pass the budget waits in `awaiting_funds` with deposit
stage `budget-wait` (never failed for its age: its funds are there) and starts as soon as the budget
allows; while funded swaps fill it, new swaps are refused with `503 sponsor-budget`. A re-armed
deposit (section 13.1) waits the same way. Each paid start counts as `SWAP_DUST_PER_START_SPECKS`
(2.2 DUST) and each settle as `SWAP_DUST_PER_SETTLE_SPECKS` (0.4 DUST): 5.2 DUST a swap. Set the
budget to what your NIGHT generates in a day. `/v1/health` `bridge.budget` shows the spend and whether
new swaps are refused.

**Who may open a swap.** Each EVM address may start at most `SWAP_MAX_PER_OWNER_PER_DAY` (10) swaps in
24 hours and have 3 in progress (`429 too-many-swaps`). A new swap (and the revival of an expired one
that never received anything) needs the address to hold, on Sepolia, the pay amount of the pay token
and the sweep's ETH: otherwise `422 insufficient-funds` (detail `token` or `eth`; one read of each,
reused for `SWAP_OWNER_BALANCE_CACHE_SECONDS`, 30 s). Each client (an IPv4 address, or an IPv6 /48:
one site's allocation, so users behind one /48 share it) may have `SWAP_MAX_UNFUNDED_PER_CLIENT` (10)
swaps waiting for funds (`429 too-many-swaps`, detail `client`), and all clients together
`SWAP_MAX_UNFUNDED` (1,000, `503 sponsor-busy`: a backstop only, since the deposit reads are budgeted
per pass). A swap waits for funds until its WHOLE pay amount has reached its deposit address: one
base unit there does not take it out of the caps.

### 4.5 Low DUST

Below `SPONSOR_DUST_LOW_SPECKS` (default 10 DUST):

- new swaps are refused (`503 sponsor-low`, the page says "try again later");
- deposits are not started: the user's funds wait at the deposit address, and the sponsor starts the
  deposit as soon as the balance is back;
- withdrawals are refused (`503 sponsor-low`), so the tokens wait in the temporary wallet;
- `/v1/health` shows `sponsor.dustLow: true` and `degraded`.

The stale closer spends nothing below `STALE_CLOSER_MIN_DUST_SPECKS` (default 20 DUST).

**The balance dips while a transaction is pending.** The wallet books a whole DUST coin until the
transaction lands, so `sponsor.dustSpecks` can drop by far more than the fee for a block or two (P3
saw 49,660 → 41,074 → 49,658 DUST around one spend). Alert on `dustLow` only when it lasts more than
10 minutes. With a single DUST coin the balance reads near zero during every spend, which is why
section 4.3 funds the wallet in several transfers.

## 5. The Sepolia RPC file

The sponsor uses a Sepolia JSON-RPC endpoint to watch deposit addresses, follow the vault's transfers
(broadcast, finality), read the vault account's nonce and gas, and size the sweep gas. A keyed
provider (Infura, Alchemy, …) is recommended: each bridge leg polls Sepolia for about 20 minutes. The
URL usually carries an API key, so it is a secret. Write it to a file without putting it in your
shell history:

```sh
sudo install -m 600 -o 1000 -g 1000 /dev/null /srv/emt/secrets/sepolia-rpc.url
sudo ${EDITOR:-vi} /srv/emt/secrets/sepolia-rpc.url     # one line: the https URL
```

Set `SEPOLIA_RPC_URL_HOST_FILE=/srv/emt/secrets/sepolia-rpc.url` in `deploy/.env`. Without it the
sponsor starts with the bridge off.

Both secret files are mounted into the sponsor at `/run/secrets/`, read-only. Compose mounts a file
secret with the host file's owner and mode, and the sponsor runs as uid 1000, so keep both files
owned by `1000:1000` with mode 600 (`sudo chown 1000:1000 /srv/emt/secrets/*`). The sponsor registers
both values with its log redactor at start; they never appear in logs, `/v1/health` or `/v1/config`.

## 6. The vault key directory

The sponsor calls the vault and proves the swaps' withdrawals with the vault's compiled module and
keys, which must match what is deployed on stagenet: the vault `7771c9e5…` and its callee, the
Signet singleton `1df4ce25…`. The `vault-keys` job builds that directory once and proves it is the
right one before the sponsor starts. The sponsor checks it against the chain again at every start
(`bridge.keysVerified` in `/v1/health`).

### 6.1 What the job does (`deploy/vault-keys/build.sh`)

1. Checks its pinned inputs: compactc 0.34.0 (release archive, SHA-256 checked when the image is
   built), `@sig-net/midnight` 0.23.0, and the three Compact sources of acedward/passport @
   `6c7505a4d2ec223fce5eb10266c331576805465a` (each SHA-256 pinned in the script).
2. Compiles, with keys, the Signet singleton and then the vault.
3. Verifies: the verifier keys of the six bridge circuits (`startDeposit`, `completeDeposit`,
   `abandonDeposit`, `startWithdraw`, `completeWithdraw`, `refundWithdraw`) and the singleton's
   `signBidirectional` must equal the ones deployed on chain (read from the indexer). It writes the
   report `.vault-keys.json`.
4. Installs the directory only if everything passed. Any failure exits non-zero and installs nothing.

In P3 the compile took 126 to 131 s and 941 MB on the test host; the script allows 10 to 20 minutes on
a slower one. `VERIFIED: 7 verifier keys equal the chain's`.

### 6.2 Run it

```sh
docker compose -f deploy/compose.yml up vault-keys          # first time: compile, verify, install
docker compose -f deploy/compose.yml run --rm vault-keys verify   # later, by hand: verify only
```

Every `up` runs the job in `ensure` mode: it re-verifies an installed directory (a few seconds),
otherwise it compiles.

### 6.3 If it fails

- `… is not the pinned source`: the image was built from other sources. Rebuild the image from a
  release of this repository.
- `… does not verify against the chain`: the vault or the singleton on stagenet is not the one this
  release was built for (a redeploy or a maintenance update), or the indexer answered wrongly. Run
  `docker compose -f deploy/compose.yml run --rm vault-keys verify` again for the report, then see
  section 14.3. **Do not start the sponsor** on a directory that fails (Compose will not).
- The indexer unreachable: the job fails; start it again later.

### 6.4 Import a directory built elsewhere

A directory with `Erc20Vault/` and `SignetSigner/` side by side, compiled from the same commit, can be
imported instead of compiled. It goes through exactly the same verification:

```sh
docker compose -f deploy/compose.yml run --rm -v /path/to/vault-managed:/import:ro vault-keys import
```

Do not import MN Bank's key set: it was compiled from an earlier vault commit (`51c1fb4`, whose
`index.js` differs) and keeps only the prover keys MN Bank uses. **The sponsor runs only the reviewed
build of the directory's JavaScript**: before importing `Erc20Vault/contract/index.js` and
`SignetSigner/contract/index.js` it checks their SHA-256 (`d98e12ad…9296` and `61464470…6a95`, the
compile of the pinned sources; the web's wallet vendors the same bytes). Any other build is refused
before it runs (`bridge.keysVerified: false`, "not the reviewed build" in the log), so an imported
directory must be byte-identical to the compile.

## 7. Gas for withdrawals: the vault's EVM account

Every withdrawal to Sepolia (a swap's received token, or a Bridge back) is a transfer **from the
vault's own EVM account**, `0x648216975e722494bFF92E88FFc68C8F8d438FaA`, signed by Sig Network's MPC.
That account pays the Sepolia gas. **MN Bank's withdrawals pay from the same account**, and so does
anyone else using the vault.

| Fact | Value |
|---|---|
| Gas each withdrawal is signed with | limit 100,000, priority 1 gwei, max fee **max(10 gwei, 2 × the base fee + 1 gwei)**, sized from the live base fee when the page asks for `withdraw-params`; above `BRIDGE_EVM_MAX_FEE_CAP_WEI` (100 gwei) withdrawals are refused until gas is cheaper ("Sepolia gas is unusually expensive"). The sponsor re-checks it against the base fee at the head of the lane (`stale-gas`: the page rebuilds with the current fee) |
| Needed in the account **at the start** of a withdrawal | limit × max fee: 0.001 ETH at 10 gwei, more when the base fee is high; the sponsor refuses to start below it |
| Actually spent per withdrawal | about 0.00007 ETH (34,477 gas measured in P3) |
| `/v1/health` warns (`vaultGas.low`) below | 0.002 ETH (`VAULT_GAS_LOW_WEI`) |
| Balance on 2026-09-29 | 0.0356 ETH |

Send Sepolia ETH to the address from any funded Sepolia wallet when `vaultGas.low` is true.

Deposits are different: the user's own wallet sends the gas for the deposit's sweep, together with
the token (section 11). The sponsor pays nothing on Sepolia.

## 8. Health monitoring

`GET /v1/health` (also `/health`) on the sponsor. From the host:
`curl -s http://127.0.0.1:18091/v1/health`. It is also reachable through the site at
`/sponsor/v1/health` (public facts only). Probes of the proof server, kernel, batcher and Sepolia are
cached for `HEALTH_CACHE_SECONDS` (15 s), one refresh at a time; the route is rate-limited per client
(`RATE_LIMIT_HEALTH_PER_MIN`, 60).

The HTTP status is 200 for `ok` and `degraded`, and 503 for `down`.

| Field | Meaning | What to do |
|---|---|---|
| `status` | `down`: the proof server is unreachable, or the sponsor wallet is in error. `degraded`: the wallet is not synced, DUST is low, the kernel or batcher is unreachable, the vault gas is low, the proof server's version is not the expected one, or the bridge is not loaded. `ok` otherwise. | Alert on `down` at once; on `degraded` for more than 10 minutes. |
| `network`, `version`, `uptimeSeconds` | What runs, and since when. `version` is `SPONSOR_VERSION` (set it to the commit). | An `uptimeSeconds` that keeps resetting means restarts: read the logs. |
| `sponsor.configured`, `state`, `synced` | `state` is `starting`, `syncing`, `synced`, `error`, `stopped` or `disabled`. | `syncing` for about 2 minutes after a start is normal. `error`: restart the sponsor; if it repeats, check the node and indexer. |
| `sponsor.dustSpecks`, `dustLow` | DUST balance in specks (10^15 per DUST), and whether it is under the low level. | Section 4.5. |
| `proofServer.reachable`, `version`, `jobCapacity` | The proof server answers, its version (must be `9.0.0-rc.6`, `PROOF_SERVER_EXPECTED_VERSION`), and its queue size (10). | `reachable: false`: check the proof server; an out-of-memory kill shows as a restart. |
| `queue.lanes.prover` | The sponsor's proofs running (at most 1) and waiting. | A `waiting` that stays high means users wait for `/prove`. |
| `queue.lanes.withdrawal` | Withdrawal starts running (at most 1) and waiting (section 9). A start holds the lane only for its checks and its submission (seconds). | A `running` held for more than a minute: the node or the proof server is slow. |
| `queue.lanes.drives` | Swaps being driven in the background (deposits, withdrawals after their start). | Informational; each lasts about 20 minutes. |
| `kernel.reachable`, `kernel.synced` | The exchange answers and has caught up. | `false`: new swaps cannot be checked and the page cannot list offers (section 13.5). |
| `batcher.reachable` | The batcher answers its health check. | `false`: takes fail (section 13.5). |
| `vaultGas.address`, `balanceWei`, `low` | The vault's EVM account and its Sepolia ETH; `balanceWei: null` means the Sepolia RPC did not answer. | `low: true`: section 7. `null` for long: check the RPC file and provider. |
| `bridge.available`, `keysVerified` | The bridge is loaded (the key directory, the Sepolia RPC); the key directory matched the chain at start. | `available: false`: new swaps are refused; read the sponsor's start-up log. `keysVerified: false`: section 6.3. |
| `bridge.swaps` | Swaps by state (`awaiting_funds`, `depositing`, `minted`, `taking`, `taken`, `withdrawing`, `bridging_back`, `done`, `failed`). | Many `awaiting_funds` are normal (users who never sent funds; they fail after 3 hours, and are dropped 2 days later). |
| `bridge.budget` | The DUST the sponsor paid in the last 24 hours and its daily budget (specks), the swaps opened in 24 hours, the swaps waiting for funds that received nothing and their cap, and `exhausted` (new swaps refused). | `exhausted` for long: raise `SPONSOR_DAILY_DUST_BUDGET` if the DUST is there, or look for abuse (many swaps from few addresses). `unfundedOpen` near `unfundedMax`: new swaps get `503 sponsor-busy`. |
| `bridge.reservations` | The vault account's nonces this sponsor's open withdrawals hold (section 9): each with its swap, whether the MPC signed it and whether it is mined, `stuck`, and `uncertain` (a submission whose outcome is not known yet). | Any `stuck: true`: section 13.7. An `uncertain: true` older than 20 minutes: section 13.2. |
| `bridge.mpc.lastSignatureAfterSeconds`, `timeouts24h`, `inFlight` | How long the MPC took to sign the last request this sponsor drove, the requests whose signature took more than 20 minutes in the last day, and the requests being followed now. | Normally 20 to 110 s. Timeouts: section 13.4. |
| `bridge.staleCloser.enabled`, `lastScanAt`, `closed24h`, `maxPerDay`, `paused` | The stale closer (section 13.3). | `paused` says why it holds back. |

Also watch:

- `docker compose -f deploy/compose.yml ps`: `web` and `sponsor` show `(healthy)`. The proof server
  image has no shell or HTTP client, so it has no Docker health check; the sponsor reports it.
- `docker compose -f deploy/compose.yml logs -f sponsor`: JSON lines. Every request is one line;
  swaps are logged by id (`swap opened`, `deposit minted`, `withdrawal refunded`, `swap done`, …).
  Secrets are redacted by key and by value.
- `docker compose -f deploy/compose.yml logs web`: one line per request, without query strings or
  headers (the swap token is a header).

## 9. The withdrawal lane, and MN Bank on the same vault (Q9)

Every withdrawal from the vault is a Sepolia transfer from its one EVM account, so all withdrawals
share one **nonce** sequence. The MPC signs each transfer with "the account's pending nonce" at the
time of the start.

**Inside this sponsor**, withdrawals go through ONE lane:

1. The page asks for `withdraw-params`: among other things the nonce the withdrawal must sign (the
   vault account's pending nonce, past every nonce this sponsor's open withdrawals hold) and the gas,
   sized from the live base fee (section 7). It builds and proves the `startWithdraw` with them, then
   hands the bound transaction to the sponsor.
2. At the head of the lane, the sponsor computes the expected nonce again. If it moved (another
   withdrawal started meanwhile), it answers `stale-evm-nonce`; if the base fee rose above the
   transfer's cap, `stale-gas`; if the vault moved, `stale-vault-state`. Nothing was paid; the swap's
   view says `withdrawal.retry: true` and the page rebuilds and proves again, automatically.
3. It adds DUST and submits. **The lane is released as soon as the start is on chain**: from then on
   the withdrawal's record in `swaps.json` holds its nonce (a *reservation*) until the request
   settles or the nonce is used on Sepolia, across restarts and MPC timeouts. So two of this sponsor's
   withdrawals never share a nonce, and a transfer that is slow to be signed or mined never holds up
   the next withdrawal. **A submission whose outcome is unknown** (the node timed out, the indexer is
   behind, the sponsor stopped mid-submission) keeps its nonce too: the swap stays `withdrawing` /
   `bridging_back` with stage `submission-uncertain` (the page waits), and the sponsor settles it by
   its request id: open in the vault → `adopted`, it runs; already attested → that outcome; neither →
   `failed` with `not-included` (the page rebuilds), but only once BOTH hold: it was sent at least
   `WITHDRAW_UNCERTAIN_SECONDS` (15 minutes) ago, and the vault was read AS OF an indexer block whose
   time is at least `WITHDRAW_EXPIRY_MARGIN_SECONDS` (2 minutes) past the transaction's expiry (its
   DUST intent lives one minute; the sponsor records that moment before the node sees it). A lagging
   indexer, or an attestation lookup that fails, never decides it: the attempt stays uncertain and
   keeps its nonce. An attempt judged `not-included` releases its nonce (the next withdrawal may take
   it, so the vault account's nonces have no gap) but is re-checked for `WITHDRAW_RECHECK_SECONDS`
   (24 hours): if its request shows up in the vault after all, it is adopted again and driven, and if
   another withdrawal took its nonce meanwhile, the pair is settled like a replacement (step 5: one
   transfer is mined, the other is refunded). While any attempt of a swap is unsettled, no new attempt
   of it is authorised (`409 withdrawal-in-progress`); older attempts count too.
4. The relayer then follows the request outside the lane: it waits for the MPC's signature, broadcasts
   the signed transfer again every minute until it is mined (or its nonce is taken), and waits for the
   attestation (about 17 minutes); every wait has a deadline, after which the stale closer takes over
   (section 13.3). Then `completeWithdraw` (or `refundWithdraw`).
5. **A stuck transfer is replaced.** Sig Network's MPC attests a transfer only once it is mined, or once
   another transaction took its nonce; it never gives up on one that is simply not mined (the plan's
   Evidence log, "C2 research"). So when a signed transfer stays unmined for
   `WITHDRAW_STUCK_AFTER_SECONDS` (30 minutes) while the base fee is above its cap, or a start is still
   unsigned after `WITHDRAW_UNSIGNED_STALE_SECONDS` (2 hours), the NEXT withdrawal is handed that
   nonce: one of the two transfers is mined, the other is attested "never executed" and refunded, and
   its page retries. The replacement outbids EVERY transfer already holding that nonce on BOTH fee
   fields, `maxPriorityFeePerGas` and `maxFeePerGas`, by at least `BRIDGE_EVM_REPLACEMENT_BUMP_PERCENT`
   (10%, rounded up), with the fee still at least 2 × the base fee + tip and at most the cap: Sepolia's
   nodes refuse a replacement that raises only the fee cap ("replacement transaction underpriced"),
   and both transfers would then hang. Tested against a geth dev node's pool
   (`scripts/replacement-pool-check.sh`). Section 13.7 has the procedure when no next withdrawal
   comes.

**MN Bank's relay has its own lane on the same vault** and the two do not coordinate (question Q9,
default A: accept rare collisions now, a shared host lock later). Two effects:

- **A collision** (rare): when both start a withdrawal within about a minute of each other, before
  either transfer is broadcast, both are signed for the same nonce. Only one transfer can land. The
  other is attested "never executed", and its request is refunded:
  - for this app: the sponsor runs `refundWithdraw`, the coin returns to the swap's temporary wallet,
    the swap goes back to `minted` with `withdraw.refunds` counted and `withdrawal.retry: true`, and
    **the page rebuilds and resubmits the withdrawal by itself**. If the page is closed, the coin
    waits in the temporary wallet until the user resumes (one signature). A collision costs about 18
    more minutes and about 2.6 DUST;
  - for MN Bank: its customer's withdrawal is refunded to their account by MN Bank's relay (its
    runbook, section 14.1).
- **MN Bank waits for this app's withdrawals.** MN Bank's relay starts no withdrawal while any
  withdrawal request is open in the vault, whoever opened it (its customers see "another withdrawal
  is still being processed by the vault; try again in a few minutes"). Each of this app's
  withdrawals, and each Bridge back, stays open from its start until `completeWithdraw`: about 18
  minutes, longer when the MPC is slow. This sponsor does not wait for MN Bank's open requests; it
  only needs the nonce to match. Expect MN Bank's customers to be told to retry during this app's
  withdrawals.

How to see a collision: the swap's withdrawal stages show `evm-not-broadcast` or an `attested`
`never-executed`, then `refunded`; the sponsor logs `withdrawal refunded`; MN Bank's logs show a
withdrawal started in the same minute.

The follow-ups are recorded under question Q9 and go into the issue the project's handoff files
(plan P4.3): B, a host-level lock that both services take from "read the nonce" until the MPC
transfer is broadcast, removes the collisions; MN Bank's wait is MN Bank's own rule, and only a
change to MN Bank's relay removes it (Q9 option D).

**Stale requests do not cross over.** MN Bank's stale closer only closes requests of MN Bank
accounts, and this sponsor's only closes requests of its own swaps (section 13.3).

## 10. Capacity and limits

| Limit | Value | Effect |
|---|---|---|
| Proofs | one at a time, sponsor-wide (a take about 2 s, a withdrawal about 5 to 8 s; the sponsor's own vault calls queue in the same lane) | Users rarely wait. On a shared proof server, MN Bank's proofs run beside them (`deploy/SYSTEMD.md`, step 2). |
| Withdrawal starts | one at a time, each holding the lane for its checks and submission only (seconds); its nonce is then held by its record (section 9) | Many starts a minute. The relayer, the attestation and the settle run in parallel. |
| Deposits | in parallel, one drive per swap; a deposit address is read every 15 s (`DEPOSIT_POLL_SECONDS`) for its first 10 minutes and once the whole token amount arrived (or the swap is `partial`), then every minute, then every 5 minutes after an hour; the ETH only once the token is there. The page watching a swap brings the next read forward, at most to one minute after the last (`DEPOSIT_POLL_NUDGE_MIN_SECONDS`); a pass reads at most `DEPOSIT_POLL_MAX_READS` (120) addresses, funded swaps first, then the longest due. Every `DEPOSIT_RECONCILE_SECONDS` (2 minutes) one read of the vault's open deposit requests covers every waiting swap, whatever its address shows | Each takes about 17 minutes from the user's funds to the mint. |
| Swaps in progress per EVM address | 3 (`SWAP_MAX_ACTIVE_PER_OWNER`) | The next open is refused until one finishes. |
| New swaps per EVM address | 10 in any 24 hours (`SWAP_MAX_PER_OWNER_PER_DAY`), whatever became of them | `429 too-many-swaps`. |
| Swaps waiting for funds (the whole amount not at their address yet) | 1,000 for all users together (`SWAP_MAX_UNFUNDED`, a backstop: the reads are budgeted per pass), 10 per client (`SWAP_MAX_UNFUNDED_PER_CLIENT`; an IPv4 address or an IPv6 /48) | New swaps get `503 sponsor-busy` (all) or `429 too-many-swaps` (the client) until some are funded or expire. |
| The daily DUST budget | `SPONSOR_DAILY_DUST_BUDGET` (500 DUST) over the last 24 hours' legs and those still in flight, committed when a swap's funds arrive (section 4.4) | Funded swaps wait (`budget-wait`); new swaps get `503 sponsor-budget`. |
| Opens | 10 a minute per client (an IPv6 client counts by its /48, as for every per-client limit), 5 a minute per EVM address; the address must hold the pay amount and the sweep's ETH on Sepolia | `422 insufficient-funds` otherwise. |
| Proofs per swap | 12 takes and 12 withdraw proofs per attempt (a refund, a failed start or a not-included one starts a new attempt), 48 in all (`SWAP_PROOFS_PER_SWAP_PER_DAY`), each counted over the last 24 hours; 6 a minute per swap, 20 a minute per client. Failed prover work counts in the 48; a proof refused at `/withdraw` because the sponsor could not pay is given back | `429 proof-budget` with `Retry-After`: a spent budget comes back over time, it never strands a swap. |
| Funds wait | 3 hours in `awaiting_funds` for a swap that received nothing (`SWAP_FUNDS_WAIT_SECONDS`), 24 hours once part of the token arrived (`SWAP_FUNDS_WAIT_PARTIAL_SECONDS`); a funded swap never fails for its age | Then `failed` (`funds-not-received`, `recoverable`); the user's Resume re-opens it and it waits again. Never-funded failures are dropped after 2 days (`SWAP_RETAIN_UNFUNDED_DAYS`), once their address reads empty. |
| An offer's remaining time at open | at least 30 minutes (`SWAP_MIN_OFFER_TTL_SECONDS`); the page lists only offers expiring more than 45 minutes out | |
| Batcher | 1,000 requests per 24 hours per IP, and 1,000 per 24 hours for all its clients together | Takes are sent from the users' browsers. The shared total also serves MN Bank and the ladders: past it, takes fail until the window moves. |
| Kernel | 600 requests per minute per IP | Browsers read offers directly. |
| Finished swaps | kept 30 days (`SWAP_RETAIN_DAYS`), then dropped only if nothing is left to recover: `done`, or a failure no Resume can revive, with no withdrawal attempt unsettled or re-checked and, for a failure, no token ever seen at the address | Swaps in flight, recoverable failures and anything funded are never dropped by age. |

## 11. What users must know

Put this where users read it (the site says the same on its pages):

- **A swap takes about 35 minutes**: about 17 minutes to bridge in (Sepolia finality), a few seconds
  to take the offer, and the received token arrives on Sepolia about 1 to 2 minutes after the take.
  The swap shows "done" about 18 minutes later, when the vault has settled.
- **Three signatures to start**: two identical "start swap" signatures (they create the swap's
  temporary Midnight wallet) and one to open the swap with the sponsor. If the two "start swap"
  signatures differ, the wallet does not sign deterministically: keep the tab open until the swap is
  done, because it cannot be resumed after closing.
- **Hold the funds before you start**: the swap opens only while your address holds the amount of
  the token you pay and the sweep's ETH on Sepolia.
- **Then two Sepolia transactions**: first the ETH for the deposit's sweep (about 0.00017 ETH, of
  which about 0.0001 stays at the deposit address for good), then exactly the token amount. Never
  send anything else to a deposit address: an excess cannot be recovered. If Sepolia's gas price
  rises a lot before the deposit starts, the swap asks for a little more ETH, and the page sends only
  the difference.
- **You can close the page.** Your swaps are listed in the app; Resume asks for one signature and
  continues where the swap is. Export the swap records (Local data) to resume on another device.
- **If the offer is taken by someone else meanwhile**, the page says "Swap is not available" and
  offers **Bridge back**, which returns exactly what you bridged in (another 20 minutes or so).
- **If only part of your deposit arrives** (anyone can ask the vault to sweep a deposit address, and a
  small sweep can win the race against the sponsor's), the page says how much reached the temporary
  wallet and offers **Wait for the rest** (the sponsor deposits the rest by itself; the page may ask
  for a little more ETH for the sweep) or **Bridge back** what arrived.
- **These are test networks and test tokens.**

## 12. Known limits

Accepted for this version (the plan's questions):

- the proof server sees the temporary wallet's spending keys when it proves (Q3 A; the server is
  the operator's and the wallet is disposable);
- about 0.0001 ETH is stranded at each deposit address (Q5 A);
- no automatic re-take when the offer is gone: "Swap is not available" + Bridge back (Q6);
- rare nonce collisions with MN Bank's relay, and MN Bank's customers waiting during this app's
  withdrawals (Q9, section 9);
- a swap whose "start swap" signatures differed cannot be resumed after its tab closes (Q4);
- Midnight transaction hashes are copyable text on stagenet: no stagenet explorer is known (Q11);
- the signing domains ("EVM Midnight Swap", "EVM Midnight Swap Sponsor") are constants in the code:
  renaming them makes swaps in flight unrecoverable by signing again (Q10). `APP_NAME` only changes the
  name `/v1/config` serves;
- a deposit that ends `failed` with `deposit-attempts` or `deposit-returned-false` leaves the user's
  tokens at the deposit address until the user resumes it: the Resume re-arms the deposit with a new
  `startDeposit` to the same recipient, paced (section 13.1) but never refused for good: a funded
  failure stays recoverable;
- a signed Sepolia transfer that is never mined is attested by nobody: the sponsor re-broadcasts it
  and replaces it with the next withdrawal, and section 13.7 has the rest. **A deposit's sweep that
  is signed but never mined is not replaced automatically** (Q12 A): the manual procedure is section
  13.7, step 3;
- **the daily DUST budget is one pool for all users** (audit S5, accepted): a funded user can spend it
  with legitimate deposits and Bridge backs (each about 5 DUST), after which new swaps get
  `503 sponsor-budget` and funded ones wait (`budget-wait`) until the 24-hour window moves. It is a
  testnet: raise `SPONSOR_DAILY_DUST_BUDGET` (section 4.4) if the NIGHT allows it;
- **the temporary wallet's inputs are not bound to it** (audit S7, accepted; `sponsor/src/validate/
  rules.ts`): the sponsor proves a take or a withdrawal whose coins in are any coins the caller can
  spend. A coin needs its owner's key to be spent, and every coin out goes to the temporary wallet or
  to the vault for this swap's own leg, so a third party's coin can only donate to the swap; the
  sponsor's cost is the same;
- a deposit request of anyone else that a THIRD party completed itself (`completeDeposit` is
  permissionless) is no longer in the vault's open requests, so the sponsor cannot see what it minted:
  the swap waits for funds (its address shows less) and fails after its window (recoverable). The coin
  is in the temporary wallet only if that party sealed it to the wallet's key;
- a partial deposit leaves the pay amount in several coins; a take or a withdrawal spends at most 4 of
  the wallet's coins (four sweeps won against the sponsor's, which are paced to 3 a day, would leave a
  fifth: then raise it with the maintainers);
- the sponsor keeps its swaps in one JSON file, rewritten on every change (bounded by the caps above
  and the pruning of never-funded swaps).

## 13. Incidents

To read a swap as the sponsor sees it (public values only):

```sh
docker compose -f deploy/compose.yml exec sponsor cat /data/swaps.json > /tmp/swaps.json
jq '.swaps[] | select(.swapId == "0x…")' /tmp/swaps.json      # the user's page shows the swap id
docker compose -f deploy/compose.yml logs sponsor | grep 0x…    # its log lines
```

Each record has `state`, `deposit.stages` and `withdrawals[].stages` (each stage with its time and
details), the request ids and every hash.

### 13.1 A deposit is stuck

| What the record shows | Why | What to do |
|---|---|---|
| `awaiting_funds`, stage `waiting-for-funds` | The deposit address holds less than the token amount, or less than the sweep ETH. The sponsor starts only when both are there. | Check the address on Sepolia. The user's page ("Send funds") sends only what is missing. After 3 hours with nothing (24 hours with part of the token) the swap fails (`funds-not-received`, recoverable); the user's Resume re-opens it. |
| `waiting-for-funds` with `error: sweep-gas-low` | Sepolia's base fee rose above what the ETH at the address covers: the sweep would not be mined. The swap's `sweepGas` was raised. | Nothing: the page sends the difference, then the deposit starts with the largest fee that ETH covers. |
| `awaiting_funds` with both funds present | The sponsor's DUST is low or its wallet is not synced (section 4.5), or the bridge is not loaded. | `/v1/health`. The deposit starts by itself once the sponsor is ready. |
| `waiting-for-funds` with `error: preflight-refused` or `deposit-start-failed` | The start was refused before anything moved (for example Sepolia or the proof server could not be read). | It is retried at every poll (15 s). Read the log line `deposit start failed`. |
| `depositing`, stages `started` … `evm-broadcast` … `evm-final` | Normal: the MPC signs within 20 to 110 s, then Sepolia finality and the attestation take 15 to 19 minutes. | Wait. |
| `depositing`, stage `relay-stalled` | The MPC did not sign within 20 minutes, or the attestation is late. | The stale closer drives it again (section 13.3). Check the request on the Sig Network explorer (section 13.4). |
| stages `abandoning`, `abandoned`, then `waiting-for-funds` | The MPC attested the sweep "never executed" (for example the sweep gas was too low for a Sepolia gas spike). The sponsor ran `abandonDeposit`; the tokens are still at the deposit address, and it starts again. | Nothing, unless it repeats: after 3 starts (`DEPOSIT_MAX_ATTEMPTS`) the swap fails with `deposit-attempts`. |
| `failed`, `deposit-attempts` or `deposit-returned-false` (`recoverable: true`) | Three starts never executed, or the token refused the vault's transfer. The tokens are at the deposit address; nothing was minted. | The user's Resume (the page offers it) re-arms the deposit: a new `startDeposit` to the same recipient, with fresh attempts, within the daily budget. Re-arms are paced: `DEPOSIT_REARM_COOLDOWN_SECONDS` (30 minutes) apart and at most `DEPOSIT_REARMS_PER_DAY` (3) in 24 hours; a Resume that comes too soon answers the swap still `failed`, `recoverable: true`, with `retryAt` (when it can). The failure stays recoverable (no lifetime cap). If it keeps failing the same way (a token that refuses the vault), keep `swaps.json` and raise it with the maintainers. Records written before this version are migrated at start-up. |
| `awaiting_funds`, stage `budget-wait` | The funds are all there, but the daily DUST budget is spent (section 4.4). | Nothing: the deposit starts as soon as the budget allows. Raise `SPONSOR_DAILY_DUST_BUDGET` if the NIGHT allows it. |
| `awaiting_funds` and the token LEFT the deposit address (or never showed there) | A request for this recipient swept it into the vault: the sponsor's own after a crash, or anyone's (`startDeposit` is permissionless). The vault's open deposit requests are read every 2 minutes for every waiting swap, whatever its address shows. | Nothing: once the MPC attests that sweep, the sponsor completes it (`completeDeposit`, permissionless too): this swap's token and remaining amount → stage `adopted`, then `minted`; less of the pay token → stage `completed-foreign`, then `partial` (below); another token → `completed-foreign` (the coin reaches the temporary wallet, not counted). A request is adopted as the swap's own only with both fee fields within the sweep policy; otherwise the sponsor posts its own sweep, outbidding it. |
| `partial` (deposit stage `partial`, view `partial: {minted, remaining, atAddress, options}`) | A completed request minted LESS of the pay token than the swap pays: part is in the temporary wallet, the rest at the deposit address (usually a small foreign sweep that won the race, and whose gas the address's ETH paid). | Nothing for you: the user's page offers **Wait for the rest** or **Bridge back** what arrived. The sponsor deposits exactly `remaining` by itself once the address holds it and the sweep ETH (the page tops up the ETH); later remainder starts are paced like re-arms (stage `rearm-wait`, with `retryAt`). Never failed by age. |
| stages `mpc-signed`, `evm-pending` and no `evm-broadcast` for long | The MPC signed the sweep, but it is not mined (the base fee rose above its cap, or the node dropped it). | Section 13.7. |

### 13.2 A withdrawal was refunded, or is slow

- **Refunded** (stage `refunded`, state back to `minted`, `withdraw.refunds` counted): the transfer
  did not happen. The usual cause is a nonce collision with MN Bank (section 9); others are the vault
  account running out of gas between the start and the broadcast, or a reverted transfer. The coin
  is back in the temporary wallet and the page retries by itself. If refunds repeat: check
  `vaultGas` (section 7), and whether MN Bank or another vault user is withdrawing at the same time.
- **`failed` with `stale-evm-nonce`, `stale-gas` or `stale-vault-state`** on a withdrawal attempt: not
  an incident. Something else started a withdrawal, the base fee rose above the transfer's cap, or the
  vault moved, between the page's build and the lane; the view says `withdrawal.retry: true` and the
  page rebuilds.
- **`failed` with `interrupted`**: the sponsor restarted after accepting a withdrawal but before
  submitting it. The state is back to `minted`; the page (or the user's Resume) rebuilds it.
- **Stage `submission-uncertain`**: the start was sent but its outcome is not known (section 9). The
  swap waits, its nonce kept; usually within about 15 minutes the sponsor finds the request in the
  vault (`adopted`, it continues) or concludes it never landed (`failed` with `not-included`; the page
  rebuilds). It concludes that only from a vault read at an indexer block past the transaction's
  expiry: if the indexer lags (the log says "the vault read does not cover the withdrawal's expiry
  yet") or the attestation lookup fails, the attempt stays uncertain and keeps its nonce until the
  indexer catches up. `/v1/health` `bridge.reservations` shows it with `uncertain: true`. Nothing to do
  unless it lasts longer: then check the indexer and the vault's open requests for its `requestId`
  (section 13.4).
- **`adopted` after `failed` with `not-included`**: the request appeared in the vault within the day
  it is re-checked (the log says "a withdrawal judged not included landed after all"). It is driven to
  its settle; if another withdrawal signed the same nonce meanwhile, one of the two transfers is mined
  and the other refunded (section 9, step 5).
- **Stages `mpc-signed`, `evm-pending` and no `evm-broadcast` for more than 30 minutes**: the transfer
  is signed but not mined. Section 13.7.
- **`relay-stalled` after the start**: the request is open in the vault and its record keeps its nonce;
  the stale closer drives it again. While it is open, MN Bank's withdrawals wait (section 9).

### 13.3 The stale closer

A request this sponsor started can be left without a driver: the MPC signed late, a settle failed for
a moment, or the sponsor restarted mid-run (it resumes those at start-up; the closer catches what
that missed). An open withdrawal also keeps MN Bank waiting, and an open deposit holds the user's
funds, so the sponsor does not wait for the user.

Every `STALE_CLOSER_INTERVAL_SECONDS` (5 minutes) it looks for swaps in `depositing`, `withdrawing` or
`bridging_back` that nothing drives and that have not moved for `STALE_AFTER_SECONDS` (15 minutes),
and drives each again: the relayer loop resumes from the recorded request id, and the permissionless
settle it ends with pays the temporary wallet the vault's request names. It also settles every
withdrawal attempt whose outcome is unknown (`submission-uncertain`, and attempts recorded as failed
by an earlier version after naming a request id), and re-checks every attempt judged `not-included`
in the last 24 hours, by its request id, superseded attempts included: one that landed after all is
adopted and driven (under the same daily cap and DUST reserve, counted as a re-drive). A deposit
request is adopted only when it carries the sponsor's own parameters (the swap's token and the amount
it still needs, the deposit address's next nonce, the swap's sweep gas limit, a tip of at least the
sweep's and a fee cap of at least 1.25 × the live base fee + tip, which the ETH at the address pays):
`startDeposit` is permissionless, so anyone can open a request for a swap's recipient, with a nonce
gap or a fee that is never mined.

It never touches a request that is not one of this sponsor's swaps. Its spending is capped:

- at most `STALE_CLOSER_MAX_PER_DAY` (48) re-drives in any rolling 24 hours;
- none while the sponsor's DUST is under `STALE_CLOSER_MIN_DUST_SPECKS` (default 20 DUST), so users'
  own swaps keep priority;
- none while the sponsor wallet is not synced.

`/v1/health` `bridge.staleCloser.paused` says why it holds back; `closed24h` counts the re-drives. Set
`STALE_CLOSER_ENABLED=false` to turn it off (then only a restart resumes a stalled request).

### 13.4 The MPC is slow

Sig Network's MPC normally signs within 20 to 110 seconds, and attests after Sepolia finality, 15 to 19
minutes after the start. The sponsor waits 20 minutes for the signature; then the stage becomes
`relay-stalled` and `bridge.mpc.timeouts24h` counts it. Nothing moved on Sepolia; the stale closer
tries again.

Check a request on Sig Network's explorer:
`https://sig-net.github.io/explorer/midnight/explorer?networkId=stagenet&requestId=0x…`. If every
request is slow, the MPC network is degraded: there is nothing to restart on your side.

### 13.5 The kernel or the batcher is down

- The page cannot list offers, and new swaps are refused (the sponsor cannot check the offer).
- Swaps in flight keep bridging. A take fails until the batcher is back: the page shows the
  exchange's refusal, the tokens stay in the swap's temporary wallet, and the user tries again later.
- `/v1/health` shows `kernel.reachable: false` or `batcher.reachable: false`, and `degraded`.
- Tell the exchange's operator. A batcher answering 429 means its daily cap (section 10).
- A take refused because another taker won (node error 239) is not an incident: the page shows "Swap
  is not available" and Bridge back.

### 13.6 Other failures

| Symptom | Likely cause | Action |
|---|---|---|
| The sponsor exits with code 78 | A configuration error | The first log line names the setting (`config: …`). |
| The sponsor exits with code 75 | The sponsor wallet could not be opened (the network, or a held lock file) | Read the log; check the seed file, `SPONSOR_DEDICATED_WALLET` and `SPONSOR_FUNDING_LOCK_FILE`. |
| The sponsor exits at start with `swaps.json is not valid JSON` or `is not a … file` | The data file is damaged | Restore `swaps.json` from the backup (section 14.1). The sponsor never starts over a damaged file. |
| `status: down`, `proofServer.reachable: false` | The proof server stopped or ran out of memory | Restart it; raise its memory limit if it was killed. |
| `bridge.keysVerified: false` | The key directory does not match the chain | Section 6.3. |
| `sponsor.state: error` | The wallet lost the node or the indexer | Restart the sponsor; check stagenet. |
| Withdrawals refused: "vault gas" in the message | The vault's EVM account holds less than 0.001 ETH | Section 7. |
| New swaps refused: "Sepolia gas is unusually expensive" | The sweep would cost more than `SWEEP_MAX_WEI` (0.005 ETH) | Wait for the spike to pass. |
| Withdrawals refused: "Sepolia gas is unusually expensive" | 2 × the base fee + 1 gwei is above `BRIDGE_EVM_MAX_FEE_CAP_WEI` (100 gwei) | Wait for the spike to pass; the coins wait in the temporary wallets. |
| `bridge.keysVerified: false` and "not the reviewed build" in the log | The key directory's `index.js` is not the pinned build (section 6.4) | Rebuild the directory with the key job (section 6). |
| The sponsor exits with code 78: "must come from …_FILE on a live network" | `SPONSOR_SEED` or `SEPOLIA_RPC_URL` was set as a plain environment value | Use `SPONSOR_SEED_FILE` / `SEPOLIA_RPC_URL_FILE` (a plain value is visible in `docker inspect`). |
| New swaps refused: `503 sponsor-busy` or `503 sponsor-budget` | The cap of swaps waiting for funds, or the daily DUST budget spent by funded swaps (section 10) | `/v1/health` `bridge.budget`. |
| New swaps refused: `422 insufficient-funds` | The user's address does not hold the pay amount or the sweep's ETH on Sepolia (section 4.4) | Not an incident: the page says what is missing. |
| New swaps refused: `429 too-many-swaps` with detail `client` | That client (its IPv4 address or IPv6 /48) has 10 swaps waiting for their whole amount | Not an incident unless many users share one address or /48 (then raise `SWAP_MAX_UNFUNDED_PER_CLIENT`); behind a proxy, set `SPONSOR_TRUST_PROXY=true` or every user is one client. |
| Withdrawals refused: `409 withdrawal-in-progress` with detail `uncertain` | An earlier attempt of that swap may still land (section 13.2) | Wait; it settles within about 15 minutes. |
| Proofs refused after a stagenet upgrade | The ledger moved | Section 14.3. |

### 13.7 A Sepolia transfer is signed but not mined

**What it looks like**: a withdrawal or a deposit whose stages end with `mpc-signed` and `evm-pending`
(the `mpc-signed` stage records the transfer's `maxFeePerGas`) and no `evm-broadcast` for more than
30 minutes; for a withdrawal, `/v1/health` `bridge.reservations` shows it with `signed: true`,
`mined: false`, and `stuck: true` once it is 30 minutes old. On Sepolia the transfer is pending (or
unknown to the explorer: dropped).

**Why nothing settles it by itself**: Sig Network's MPC attests a transfer when it is mined (success
or reverted), or when another transaction from the same account took its nonce ("never executed").
It has no timeout for a transfer that is simply not mined, so the request, and the user's coin (a
withdrawal) or tokens (a deposit), stay open until one of those two happens.

**What the sponsor does**:
- while it drives the request, it broadcasts the signed transfer again every minute; the transfer is
  mined as soon as the base fee falls under its cap. Each drive has a deadline; the stale closer
  starts another (section 13.3);
- **withdrawals**: once the reservation is stuck (30 minutes unmined with the base fee above its cap,
  or 2 hours unsigned), the NEXT withdrawal of any swap signs the same nonce with fee fields that
  outbid it on both the tip and the cap by at least 10% (section 9). One of the two transfers is
  mined; the other is attested "never executed" and refunded to its temporary wallet, and that swap's
  page retries. If the replacement gets stuck too, the next one outbids both.

**What you do**, in order:
1. Compare the Sepolia base fee with the transfer's `maxFeePerGas`. If the base fee is already back
   under it, the next re-broadcast gets it mined: wait for the stale closer (or restart the sponsor,
   which resumes every swap in flight at once).
2. A stuck **withdrawal** with no other withdrawal coming: any withdrawal from the vault signed with
   the same nonce and a higher fee resolves it. The quickest is another swap's withdrawal through this
   sponsor (it is handed the stuck nonce automatically); a Bridge back of a small test swap works.
   Withdrawals by other vault users (MN Bank) consume the nonce too, if theirs uses it.
3. A stuck **deposit** sweep: the deposit address's nonce is only ever used by the vault's sweeps for
   that recipient, and the sweep was signed with the largest fee the ETH at the address covered, so
   the usual cure is to wait for the base fee to fall (step 1). If it does not, raise it with the
   maintainers: a replacement sweep (a new `startDeposit` for the same recipient, the same
   deposit-address nonce and a higher fee, after the user tops up the address's ETH; the vault allows
   several open requests per recipient) is possible but not automated in this version.
4. Never edit or delete the swap's record while its request is open: it holds the vault account's
   nonce (the reservation) and the request id the settle needs.

## 14. Start, stop, upgrade and re-pin

All commands take `-f deploy/compose.yml`; add `--env-file` if the settings are not in `deploy/.env`.

### 14.1 Everyday commands

| Task | Command |
|---|---|
| Start (or apply changed settings) | `docker compose -f deploy/compose.yml up -d` |
| Status | `docker compose -f deploy/compose.yml ps` |
| Logs | `docker compose -f deploy/compose.yml logs -f sponsor` (or `web`, `proof-server`, `vault-keys`) |
| Restart the sponsor | `docker compose -f deploy/compose.yml restart sponsor` (the wallet re-syncs, about 2 minutes) |
| Stop (keeps volumes) | `docker compose -f deploy/compose.yml stop` |
| Remove containers (keeps volumes) | `docker compose -f deploy/compose.yml down` |
| Remove everything | `docker compose -f deploy/compose.yml down -v`: **this deletes `swaps.json`**; never while swaps are in flight |

**Restarting is safe.** Every swap step is written to `swaps.json` before and after it runs, and at
start the sponsor resumes every deposit and withdrawal in flight from its recorded request id. A
withdrawal it had accepted but not yet submitted goes back to `minted` (`interrupted`), and the page
rebuilds it; one it was submitting is `submission-uncertain` until its request id settles it
(section 13.2). Prefer to restart when `queue.lanes.withdrawal` shows 0 running and 0 waiting.

**Back up** the sponsor seed file and `swaps.json`:

```sh
docker compose -f deploy/compose.yml exec sponsor cat /data/swaps.json > swaps-$(date -u +%F).json
```

`swaps.json` holds no secret, but without it the sponsor cannot resume the swaps in flight. The key
volume can be rebuilt.

### 14.2 Upgrade to a new version of this repository

```sh
git fetch && git checkout <new release>
docker compose -f deploy/compose.yml build
docker compose -f deploy/compose.yml up -d
```

Upgrade the web and the sponsor **together**: the page and the sponsor API move together. A
withdrawal proven by the previous sponsor version is not sent as it is: `/withdraw` answers
`409 stale-vault-state` (detail `approval-outdated`) and the page rebuilds and proves it again. The
`vault-keys` job re-verifies; if the new version changed a key input (the vault commit, compactc, the
Signet module), rebuild the key directory with the sponsor stopped:
`docker compose -f deploy/compose.yml run --rm vault-keys compile` (or `import`). The old directory is
replaced only after the new one verifies.

### 14.3 Re-pin when something upstream moves

Check stagenet before and after any change:

```sh
curl -s -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}' https://rpc.stagenet.shielded.tools
# pinned: "2.0.0-d9729c13" (ledger crate-ledger-9.1.0.0-rc.3)
```

| What moved | What to do |
|---|---|
| **acedward/passport PR #4** (the vault or its token records) | If the addresses or colours changed, the records must be re-vendored (`packages/core/src/tokens/deployments/`, see its `PROVENANCE.md`) and a new release built. If the vault was redeployed or updated, the key job's chain check fails, and the sponsor stays down, until a new release pins the new sources (`deploy/vault-keys.Dockerfile`, `build.sh`) and re-vendors the vault module the page builds withdrawals with (`packages/wallet/src/vendor/vault/`): they move together. |
| **The Midnight SDK set** (ledger, midnight-js, wallet SDK) | A new release of this repository with the whole set moved together. |
| **The stagenet ledger or node** | Wait for a release that moves the SDK set, the proof server and, if needed, compactc together. Do not mix versions. |
| **The proof server** | Only with the SDK set: the digest in `deploy/compose.yml` and `PROOF_SERVER_EXPECTED_VERSION`. Natively the proof server is MN Bank's: move both services together, or give this sponsor its own (`deploy/SYSTEMD.md`, step 2). |
| **The kernel or batcher URL** | `ZSWAP_KERNEL_URL` / `ZSWAP_BATCHER_URL` in the sponsor's settings, then restart. The page takes its endpoints from its build's network profile (or `config.json` `overrides`). |

## 15. Reference: pins and addresses

| Item | Pin |
|---|---|
| Stagenet node / ledger | `2.0.0-d9729c13` / `crate-ledger-9.1.0.0-rc.3` |
| Proof server | `midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b` (2 workers, a 10-job queue, a 600 s job timeout: its defaults) |
| Compact compiler | compactc 0.34.0, `--feature-zkir-v3`; archives SHA-256: `x86_64-unknown-linux-musl` `775ccddf5a71399835329bbf7471ba5a8c54fcc825d372c75e19ba7042069584`, `aarch64-unknown-linux-musl` `d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d` |
| Base images | `oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7`, `nginx:1.31.5-alpine@sha256:72ba65eb42c10344912a84ff42408db7d34f2feb642204570ab8fc5ffd29f1d3` |
| Vault sources | acedward/passport @ `6c7505a4d2ec223fce5eb10266c331576805465a`, `contract/contracts/erc20-vault/src/`: `erc20-vault.compact` `d68c2e02…f19c9`, `vendor/signet-contract.compact` `004c8acd…ad808`, `vendor/TokenMetadata.compact` `1f1f9424…ca078` (SHA-256) |
| SDK set | `@midnightntwrk/ledger-v9` 1.0.0-rc.3, midnight-js 5.0.0-beta.7, wallet-sdk-facade 5.0.0-beta.2, compact-runtime 0.19.0, `@sig-net/midnight` 0.23.0 |
| Vault (Midnight) | `7771c9e53afb45291ae2cecd48b5d55262734b08a98fc8276ed0f980031cd637` |
| Vault's EVM account (Sepolia) | `0x648216975e722494bFF92E88FFc68C8F8d438FaA` |
| Signet singleton | `1df4ce25fc9f9c03dc6f4d0eb12ddf3d0db094995d4c70aca1142eebb3b77a5d` |
| MPC output cache | `https://storage.googleapis.com/midnight-cache-storage-testnet/v1/stagenet` |
| Signing domains (EIP-712) | "EVM Midnight Swap" (the "start swap" key derivation) and "EVM Midnight Swap Sponsor" (open-swap), chain id 11155111 |
| Tokens (Sepolia → Midnight, 6 decimals each) | stkA `0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52` → wStkA `5eb2a3ce…6a02`; stkB `0xF2bEFf36543219C8feC2AB2f42070AA65D3C844B` → wStkB `e7ca18cb…9588`; stkC `0x70c5c1978e5d428fa5C82111980e1aF0A64a270D` → wStkC `db8ae472…19d9`; USDC (Circle) `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` → wUSDC `e5afe273…bb2d`; TBILL `0x1531b11722CF9b600816ED0eAcBc49594DbB991f` → TBILL `05b32284…a8e9`; TB13W `0x5cF366decA552c30eBB2504d0b9Ee104A99f1c72` → TB13W `b3d96e99…512b`; TB26W `0x26dB7221903e62310409e454442adBb46E0B6E33` → TB26W `7b044b55…3b62`; TB52W `0x02A0D1BaF66351715A84aC4763b82f1155BdD5b0` → TB52W `8f4798a5…9ec2` |
| Endpoints | node `https://rpc.stagenet.shielded.tools`; indexer `https://indexer.stagenet.shielded.tools/api/v4/graphql`; kernel `https://stagenet.api-zswap.zkdojo.com`; batcher `https://stagenet.batcher-zswap.zkdojo.com` (target `midnight-balancer`) |

Every sponsor setting, with its default, is in `sponsor/README.md` ("Configuration"); the bundle's
settings are in `deploy/.env.example`.

## 16. What was tested

| What | How | Result |
|---|---|---|
| The Compose bundle, end to end, live | Plan 00048 P3 (2026-09-29/30): `deploy/compose.yml` built and run on Docker Desktop (macOS), against stagenet and Sepolia; the real UI driven by Playwright with an injected EVM wallet | **PASS**: a complete swap (exactly −1.04 USDC / +100 stkA, 4.66 DUST, resumed after closing the page mid-bridge-in) and "Swap is not available" → Bridge back (exactly 108.695653 stkA back, 4.70 DUST); both temporary wallets empty. Every hash is in the plan's Evidence log |
| The key job | Compiled from the pinned sources in 126 to 131 s, `VERIFIED: 7 verifier keys equal the chain's`; the import mode verified too | PASS |
| The sponsor's settings, health and refusal rules | The repository's unit tests (CI) | PASS |
| Secret files owned by uid 1000 on a Linux host (section 5) | Not exercised: Docker Desktop maps file ownership | **Not tested** |
| `sponsor-wallet new`, `register-dust` and `status` on a new wallet (section 4) | Not run: the live runs used an already funded wallet | **Not tested** |
| A nonce collision with MN Bank (section 9) | The refund path is unit-tested (a refund returns the swap to `minted`, the page retries); no live collision was provoked | Live: **not tested** |
| The native layout next to MN Bank | `deploy/SYSTEMD.md` | **Not run on a host** (see its last section) |
| The security fix pass (plan 00048 P4.2-fix, lane FS: audit rows C1–C7, C11–C16) | Unit and route tests against fakes and the recorded stagenet state (`sponsor/test/fix-pass.test.ts`, `relay-loop.test.ts`, `rebuild-wallet.test.ts`, `packages/core/test/deploy-csp.test.ts`), each failing before its fix; the web image's default CSP in Chromium (`deploy/web/csp-browser-check.sh`) | PASS offline. **Not tested live**: the relay loop now broadcasts itself (the vendored loop's receipt wait had no deadline), the live fee sizing, the lane released at the start and the replacement of a stuck transfer |
| The third fix pass (plan 00048 P4.2-fix3, lane FS3: audit rows S1–S8) | `sponsor/test/fix3-pass.test.ts` and `indexer-head.test.ts`, each failing before its fix on the previous sources (a lagging indexer and a failed attestation lookup keep a withdrawal uncertain; re-adoption after `not-included`; a foreign partial sweep → `partial` → the remainder deposited, or Bridge back; a sweep between polls; the fee policy at adoption; retention; /48 clients and the unfunded rule; the budget reservation; versioned approvals) | PASS offline. **Not tested live**: the indexer head read, the `partial` path and the reconciliation read on stagenet / Sepolia |
| The second fix pass (plan 00048 P4.2-fix2, lane FS2: audit rows R1–R6) | `sponsor/test/fix2-pass.test.ts`, `client-key.test.ts`, the real-ledger R1 checks in `rebuild-wallet.test.ts` (the wallet's own take and withdrawal with change), each failing before its fix; the replacement of a stuck transfer against a real transaction pool: a geth 1.17.6 dev node in Docker (`scripts/replacement-pool-check.sh`) | PASS offline and on the dev node's pool (the sponsor's replacement accepted and mined; a cap-only bump refused). **Not tested live**: the owner-balance check at open, the swept-deposit completion and the uncertain-submission reconciliation on stagenet / Sepolia |

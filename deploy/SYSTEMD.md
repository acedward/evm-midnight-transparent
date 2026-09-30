# EVM Midnight Swap: deploying next to MN Bank without Docker (systemd)

**State: NOT RUN ON A HOST.** This layout runs the same code as the Compose bundle, which ran live
(plan 00048 P3). The unit files, the settings file and the nginx site below were checked in a Debian 12
container with systemd running, next to MN Bank's own unit and site, with stand-ins for Bun, compactc
and the proof server (the last section says exactly what). Your MN Bank server is the first host to
run it for real.

This guide adds EVM Midnight Swap to the host that already runs MN Bank natively, as set up by MN
Bank's systemd guide (plan 00039: `mnbank-proof-server`, `mnbank-keys`, `mnbank-relay`, the nginx site
`mnbank`, the user `mnbank`, the checkout `/app`). It changes nothing of MN Bank's.

| What | Where |
|---|---|
| Operator runbook (economics, health fields, the withdrawal lane and MN Bank, incidents, upgrades) | `deploy/RUNBOOK.md` in this repository |
| Every sponsor setting, explained | `sponsor/README.md` ("Configuration") |
| The Compose bundle this layout mirrors | `deploy/compose.yml`, `deploy/web/nginx.conf` |

## What is shared with MN Bank, and what is not

| Shared | Separate |
|---|---|
| **The proof server** `mnbank-proof-server` (9.0.0-rc.6, port 6300): step 2 | The system user `emt` (MN Bank's secrets stay unreadable to it, and the other way round) |
| Bun 1.3.11 at `/usr/local/bin/bun` and compactc 0.34.0 at `/opt/compactc` (read only) | The checkouts `/opt/emt/app` and `/var/lib/emt/web-src` |
| nginx (one more site, its own server name and certificate) | **The sponsor wallet's seed** (a new wallet: never MN Bank's), the Sepolia RPC file |
| The vault's EVM account on Sepolia, which pays every withdrawal (RUNBOOK sections 7 and 9) | The settings `/etc/emt/sponsor.env`, the data `/var/lib/emt`, the port `127.0.0.1:8091` |
| | The units `emt-vault-keys` and `emt-sponsor`, the site `emt`, the logs |

## Key components

| Component | What it does | systemd unit | Listens on |
|---|---|---|---|
| **Proof server** (MN Bank's) | Proves the sponsor's vault calls, its DUST spends, and the swaps' takes and withdrawals, beside MN Bank's proofs | `mnbank-proof-server` (exists) | `0.0.0.0:6300`: it has no bind option, so **firewall it** (step 8) |
| **Vault key directory** (about 1 GB) | The ERC20 vault and the Signet singleton compiled with their prover and verifier keys. `deploy/vault-keys/build.sh` builds it once (minutes), then only re-verifies it against the chain (seconds) at every start | `emt-vault-keys` (oneshot) | — |
| **Sponsor** (Bun 1.3.11) | Pays the bridge legs' DUST from its own wallet, drives the deposits, proves for the page, runs the withdrawal lane, the MPC relayer and the stale closer. Keeps each swap's public record in `swaps.json` | `emt-sponsor` | `127.0.0.1:8091` |
| **Web** | The static site and `config.json`, served by nginx, which also proxies `/sponsor/` to the sponsor on the same origin | nginx (site `emt`) | `:443` |

**Secrets**: two files, the sponsor seed (a new wallet) and the Sepolia RPC URL.

**Sizing, on top of MN Bank's**: about 4 GB more RAM (the sponsor, estimated at 1 to 2 GB like MN
Bank's relay and capped at 4G, plus its proofs on the shared proof server) and 5 GB more disk. MN Bank's guide asks for
16 GB; plan for **20 GB** with both, or see step 2 for a 16 GB host.

**Outbound access** (the same hosts as MN Bank): the stagenet node and indexer
(`*.stagenet.shielded.tools`), the ZSwap kernel and batcher (`stagenet.*-zswap.zkdojo.com`),
`storage.googleapis.com`, `srs.midnight.network`, your Sepolia RPC, and GitHub and npm for installing.

**Inbound**: unchanged, only 22, 80 and 443.

| Path | Holds |
|---|---|
| `/opt/emt/app` | The **runtime** checkout: the sponsor, and the key directory at `/opt/emt/app/vault-managed` (it must sit inside the checkout: the compiled vault module resolves its runtime from the checkout's `node_modules`). Never run `git clean -x` here |
| `/opt/emt/vault-src` | The vault's three Compact sources at the pinned commit, for the key compile |
| `/var/lib/emt/web-src` | A second checkout, used only to build the web |
| `/etc/emt/sponsor.env` | The settings |
| `/srv/emt/secrets/` | `sponsor.seed` and `sepolia-rpc.url` (mode 600, owner `emt`) |
| `/var/lib/emt/sponsor-data` | `swaps.json` (public values only; back it up) |
| `/var/lib/emt/zk-params` | Public parameters the key compile downloads |
| `/var/www/emt` | The built site |

## 1. Base: a user and the runtime checkout

Bun 1.3.11 and compactc 0.34.0 are already installed by MN Bank's guide (step 1); this repository pins
the same versions (`packageManager`, `scripts/fetch-compactc.sh` is byte-identical to MN Bank's).

```bash
sudo useradd --system --home-dir /var/lib/emt --create-home --shell /usr/sbin/nologin emt
bun --version                          # 1.3.11
/opt/compactc/compactc --version       # 0.34.0 (only the first key compile needs it)
sudo install -d -o emt -g emt /opt/emt /opt/emt/app
sudo -u emt -H git clone https://github.com/acedward/evm-midnight-transparent.git /opt/emt/app
cd /opt/emt/app && sudo -u emt -H git checkout <commit>
sudo -u emt -H bun install --frozen-lockfile --production --ignore-scripts
```

If `/opt/compactc` is missing: `sudo env COMPACTC_DIR=/opt/compactc bash /opt/emt/app/scripts/fetch-compactc.sh`
(it checks the archive's SHA-256).

The vault's pinned sources (the same lines as the key image's `sources` stage; the key job checks each
file's SHA-256 before it compiles):

```bash
sudo install -d -o emt -g emt /opt/emt/vault-src
sudo -u emt -H bash -c '
  set -euo pipefail
  C=6c7505a4d2ec223fce5eb10266c331576805465a
  t="$(mktemp -d)"
  git init -q "$t"
  git -C "$t" fetch -q --depth 1 https://github.com/acedward/passport.git "$C"
  git -C "$t" checkout -q FETCH_HEAD
  test "$(git -C "$t" rev-parse HEAD)" = "$C"
  mkdir -p /opt/emt/vault-src/vendor
  cp "$t"/contract/contracts/erc20-vault/src/erc20-vault.compact /opt/emt/vault-src/
  cp "$t"/contract/contracts/erc20-vault/src/vendor/*.compact /opt/emt/vault-src/vendor/
  rm -rf "$t"'
```

## 2. The proof server: MN Bank's, shared

**Yes, the sponsor can share `mnbank-proof-server`.** Nothing is installed in it and it is not
restarted. What the code does (this repository, `sponsor/src/prover/`):

- **Every contract proof carries its own key material.** The sponsor's proving provider (MN Bank's
  streaming provider, copied unchanged) resolves each vault or singleton circuit in the sponsor's own
  key directory (`VAULT_MANAGED_DIR`) and sends the prover key, the verifier key and the ZKIR in the
  body of every `/prove` request (the ZKIR in every `/check`). Each request is self-contained: the
  proof server needs no configuration for either service, and the two services' key sets never have
  to be installed in it or match each other.
- **The zswap and DUST built-ins carry no key material**: the swaps' takes, the zswap part of their
  withdrawals, and the sponsor wallet's DUST spends use the proof server's own built-in keys, which
  MN Bank's server already downloaded into its `MIDNIGHT_PP`.
- **The browser never reaches the proof server**: the page sends its unproven transactions to the
  sponsor's `/prove` (through nginx), and the sponsor proves them.

What it needs:

| Requirement | Value |
|---|---|
| The same version | Both pin `9.0.0-rc.6` (`PROOF_SERVER_EXPECTED_VERSION`; a mismatch makes the sponsor's health `degraded`) |
| Reachable | `MIDNIGHT_PROOF_SERVER_URL=http://127.0.0.1:6300` |
| Capacity | rc.6 runs **2 workers** with a **10-job queue** and a **600 s job timeout** (its defaults: `midnight-proof-server --help`). MN Bank's relay proves one call at a time, and so does this sponsor, so at most one MN Bank proof and one sponsor proof run at once: neither waits for the other |
| Memory | An MN Bank k=18 proof needs about 8 GB. The sponsor's largest circuits are k=16 (prover keys up to 117 MB; `startWithdraw` is k=15), estimated at 1 to 3 GB. Together they fit under MN Bank's `MemoryMax=12G` (not measured together). On a 16 GB host, if the proof server is ever killed for memory, run it with one worker: add `--num-workers 1` to the `ExecStart` of MN Bank's `mnbank-proof-server` unit (the one change to MN Bank's side this guide ever suggests; every proof then queues, and a sponsor proof can wait up to about 80 s behind an MN Bank proof; the sponsor and nginx allow 900 s) |

```bash
systemctl is-active mnbank-proof-server        # active
curl -s http://127.0.0.1:6300/version          # 9.0.0-rc.6
curl -s http://127.0.0.1:6300/ready            # {"status":"ok","jobsProcessing":…,"jobsPending":…,"jobCapacity":10}
```

**When a second proof server is needed**: only if the two services stop sharing one SDK set, for
example when MN Bank moves to a newer proof server first. Then run this sponsor's own, from the same
binary layout as MN Bank's guide step 2 (or the version this repository pins), on another port, with
its own parameters directory, and point `MIDNIGHT_PROOF_SERVER_URL` at it. A sketch (not tested):

```ini
# /etc/systemd/system/emt-proof-server.service
[Unit]
Description=EVM Midnight Swap proof server (only when MN Bank's cannot be shared)
Wants=network-online.target
After=network-online.target

[Service]
User=emt
Group=emt
Environment=MIDNIGHT_PP=/var/lib/emt/proof-params
ExecStart=/usr/local/bin/midnight-proof-server --port 6301
Restart=on-failure
RestartSec=5
MemoryMax=6G
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

It also listens on all interfaces: firewall 6301 like 6300 (step 8).

## 3. Secrets and settings

```bash
sudo install -d -m 700 -o emt -g emt /srv/emt/secrets
#   /srv/emt/secrets/sponsor.seed     a NEW wallet, created in step 7 (never MN Bank's /srv/mnbank/secrets/sponsor.seed)
#   /srv/emt/secrets/sepolia-rpc.url  one line: a Sepolia RPC URL (it may be the same provider as MN Bank's; keep your own copy)
sudo install -m 600 -o emt -g emt /dev/null /srv/emt/secrets/sepolia-rpc.url
sudo ${EDITOR:-vi} /srv/emt/secrets/sepolia-rpc.url
sudo install -d -m 700 -o emt -g emt /var/lib/emt/sponsor-data /var/lib/emt/zk-params
sudo install -d -m 750 -g emt /etc/emt
sudo install -m 640 -g emt /dev/null /etc/emt/sponsor.env
sudo ${EDITOR:-vi} /etc/emt/sponsor.env
```

`/etc/emt/sponsor.env` (the Compose bundle's `.env.example` holds Compose-only settings, so this file
is written from scratch; every other setting keeps its default, `sponsor/README.md`):

```ini
NODE_ENV=production
HOME=/var/lib/emt
SPONSOR_VERSION=<commit>
SPONSOR_NETWORK=stagenet
SPONSOR_HOST=127.0.0.1
SPONSOR_PORT=8091
SPONSOR_TRUST_PROXY=true
SPONSOR_ENABLED=true
SPONSOR_DEDICATED_WALLET=true
SPONSOR_FEE_BLOCKS_MARGIN=20
SPONSOR_SEED_FILE=/srv/emt/secrets/sponsor.seed
SEPOLIA_RPC_URL_FILE=/srv/emt/secrets/sepolia-rpc.url
SPONSOR_DATA_DIR=/var/lib/emt/sponsor-data
VAULT_MANAGED_DIR=/opt/emt/app/vault-managed
MIDNIGHT_PROOF_SERVER_URL=http://127.0.0.1:6300
PROOF_SERVER_EXPECTED_VERSION=9.0.0-rc.6
SPONSOR_TOOL_HEALTH_URL=http://127.0.0.1:8091/health
LOG_LEVEL=info
```

- The secrets come only from the `*_FILE` settings: on stagenet the sponsor refuses a plain
  `SPONSOR_SEED` or `SEPOLIA_RPC_URL` (visible in `systemctl show` and the process table).
- The spending controls keep their defaults unless you set them (`sponsor/README.md`): a daily DUST
  budget (`SPONSOR_DAILY_DUST_BUDGET`, 500 DUST; set it to what the sponsor's NIGHT generates in a
  day), 10 new swaps per EVM address a day, 100 swaps waiting for funds (RUNBOOK section 10).
- `SPONSOR_DEDICATED_WALLET=true` says the seed is this sponsor's alone. Only set it when it is: on
  stagenet the sponsor refuses to open a wallet without it (or a lock file).
- `SPONSOR_TOOL_HEALTH_URL` matters. The wallet tool (step 7) looks for the sponsor at
  `http://sponsor:8080/health` by default (the Compose name). Natively that name does not resolve,
  and its guard ("never open the wallet while the sponsor has it") would be silently skipped.
- `SPONSOR_TRUST_PROXY=true`: the sponsor rate-limits by the one `X-Forwarded-For` entry nginx sets
  (step 6). It listens on 127.0.0.1 only, so nothing else can set that header.
- No `SPONSOR_CORS_ORIGINS`: the page reaches the sponsor on its own origin, through nginx.

## 4. The vault key directory

`deploy/vault-keys/build.sh` is the script the Compose key job runs, and it has that image's paths
built in: the checkout at `/app`, the sources at `/src/vault`, compactc at `/opt/compactc`. On this
host `/app` is MN Bank's checkout, so the unit gives the script **its own view** with `BindPaths=`:
this repository's checkout appears at `/app` and the sources at `/src/vault`, inside this unit only.
MN Bank's units still see MN Bank's `/app`.

`/etc/systemd/system/emt-vault-keys.service`:

```ini
[Unit]
Description=EVM Midnight Swap vault key directory: build once, re-verify at every start (deploy/vault-keys/build.sh)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
User=emt
Group=emt
# build.sh's built-in paths, mapped for this unit only: our checkout at /app (MN Bank's /app is
# hidden from this unit, not changed), the pinned vault sources at /src/vault.
BindPaths=/opt/emt/app:/app
BindReadOnlyPaths=/opt/emt/vault-src:/src/vault
WorkingDirectory=/app
EnvironmentFile=/etc/emt/sponsor.env
Environment=MIDNIGHT_PP=/var/lib/emt/zk-params
Environment=VAULT_SOURCE_COMMIT=6c7505a4d2ec223fce5eb10266c331576805465a
ExecStartPre=/usr/bin/mkdir -p /app/vault-managed
ExecStart=/usr/bin/bash /app/deploy/vault-keys/build.sh ensure
TimeoutStartSec=1h
MemoryMax=8G
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`ensure` re-verifies an installed directory; otherwise it imports one (when `IMPORT_DIR` names one) or
compiles. The directory lands at `/opt/emt/app/vault-managed`. The first start makes systemd create an
empty, root-owned `/src/vault` on the host as the mount point; nothing is ever written there.

A good first run ends with `vault-keys: OK: /app/vault-managed installed and verified (compile, … s, …)`;
a later start with `vault-keys: OK: /app/vault-managed verified`. The paths in these lines are the
unit's view. Anything else means don't start the sponsor; see RUNBOOK section 6.3.

- **To skip the compile**, copy a directory built elsewhere from the same commit (for example by the
  Compose key job) to a directory `emt` can read, and add `IMPORT_DIR=<that directory>` to
  `/etc/emt/sponsor.env` for the first run (the sponsor ignores it); remove the line afterwards, or a
  later rebuild (step 10) imports that directory again. It goes through the same checks.
  Do not import MN Bank's key set (RUNBOOK section 6.4): the sponsor runs only the pinned build of
  the directory's `index.js` files and refuses any other before it runs.
- **The indexer unreachable at boot** fails the check, and the sponsor stays down with it
  (`Requires=`). Start both again later: `sudo systemctl restart emt-vault-keys emt-sponsor`.

## 5. The sponsor

`/etc/systemd/system/emt-sponsor.service`:

```ini
[Unit]
Description=EVM Midnight Swap sponsor
Wants=network-online.target mnbank-proof-server.service
Requires=emt-vault-keys.service
After=network-online.target mnbank-proof-server.service emt-vault-keys.service

[Service]
User=emt
Group=emt
WorkingDirectory=/opt/emt/app
EnvironmentFile=/etc/emt/sponsor.env
ExecStart=/usr/local/bin/bun sponsor/src/main.ts
Restart=on-failure
RestartSec=10
RestartPreventExitStatus=78
TimeoutStopSec=30
MemoryMax=4G
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/emt
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

- **Exit 78**: bad settings. It is not restarted; the journal's first error names the setting.
- **Exit 75**: the sponsor wallet could not start (for example a network blip). It is restarted.
- **The keys gate the sponsor** (`Requires=`): a failed key check keeps it down. The sponsor also
  checks the keys against the chain itself at start (`bridge.keysVerified` in its health).
- `Wants=mnbank-proof-server.service`: starting the sponsor starts the shared proof server if it is
  stopped; stopping the sponsor never stops it.
- The sponsor writes only `/var/lib/emt` (its swaps and Bun's cache); it reads its checkout, its key
  directory, `/etc/emt/sponsor.env` and its two secret files.

## 6. The web, and nginx

Build in the **second** checkout:

```bash
sudo -u emt -H git clone https://github.com/acedward/evm-midnight-transparent.git /var/lib/emt/web-src
cd /var/lib/emt/web-src && sudo -u emt -H git checkout <commit>
sudo -u emt -H bun install --frozen-lockfile --ignore-scripts
sudo -u emt -H bun run build:web
sudo install -d /var/www/emt && sudo cp -r web/dist/. /var/www/emt/
sudo find /var/www/emt -name '*.map' -delete
echo '{"network":"stagenet","sponsorUrl":"/sponsor"}' | sudo tee /var/www/emt/config.json
```

The last line is needed: the built `config.json` has an empty `sponsorUrl`, and the page cannot start
a swap without one. Never put a `mock` block in it (RUNBOOK section 3).

The site loads WebAssembly (the in-browser wallet), which browsers accept only as
`application/wasm`. Debian's nginx knows the type; check with `grep wasm /etc/nginx/mime.types`
(expect `application/wasm wasm;`).

`/etc/nginx/sites-available/emt` (link it into `sites-enabled`). Put in your domain and certificate
(e.g. `sudo certbot certonly --nginx -d swap.example.com`). It is MN Bank's server block with this
app's name, root, log format and upstream, and the Compose bundle's `/sponsor/` proxy (a proof can
wait behind MN Bank's on the shared proof server, so it allows 900 s):

```nginx
# EVM Midnight Swap: the static site, plus /sponsor/ proxied to the sponsor on the same origin.
# log_format names are global in nginx: MN Bank's site defines "mnbank", this one "emt".
log_format emt '$remote_addr [$time_iso8601] "$request_method $uri" $status $body_bytes_sent $request_time';

server {
  listen 80;
  server_name swap.example.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name swap.example.com;
  ssl_certificate     /etc/letsencrypt/live/swap.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/swap.example.com/privkey.pem;

  root /var/www/emt;
  index index.html;
  # A proven withdrawal is about 21 kB (42 kB as hex); the sponsor's own limit is 2 MiB.
  client_max_body_size 2m;
  server_tokens off;
  access_log /var/log/nginx/emt.access.log emt;   # no query strings, no headers (the swap token is a header)
  gzip on;
  gzip_types text/css application/javascript application/json application/wasm image/svg+xml;
  gzip_min_length 1024;

  add_header X-Content-Type-Options nosniff always;
  add_header Referrer-Policy no-referrer always;
  add_header X-Frame-Options DENY always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
  add_header Strict-Transport-Security "max-age=31536000" always;
  # The Compose bundle's default policy for stagenet (deploy/web/csp.sh prints it:
  # sh deploy/web/csp.sh stagenet /sponsor), checked in Chromium (RUNBOOK section 3).
  add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://stagenet.api-zswap.zkdojo.com https://stagenet.batcher-zswap.zkdojo.com https://indexer.stagenet.shielded.tools wss://indexer.stagenet.shielded.tools https://rpc.stagenet.shielded.tools wss://rpc.stagenet.shielded.tools; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" always;

  location = /healthz { access_log off; default_type text/plain; return 200 "ok\n"; }
  location = /config.json { default_type application/json; expires -1; }

  location /sponsor/ {
    rewrite ^/sponsor/(.*)$ /$1 break;
    proxy_pass http://127.0.0.1:8091;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_set_header X-Forwarded-For $remote_addr;   # exactly one entry: the user (rate limits)
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 5s;
    proxy_read_timeout 900s;
    proxy_send_timeout 120s;
  }

  location /assets/ { expires 30d; try_files $uri =404; }
  location / { expires -1; try_files $uri $uri/ /index.html; }
}
```

- **If a load balancer or CDN sits in front of this nginx**, add `set_real_ip_from <its CIDRs>;
  real_ip_header X-Forwarded-For; real_ip_recursive on;` to the 443 server. Without it, every user
  shares one rate-limit bucket at the sponsor.
- **https, not http.** The page carries the swap's bearer token and its users sign with their
  wallets; serve it only over TLS. The port-80 block only redirects.
- **The Content-Security-Policy** is the Compose bundle's default (audit C15): regenerate the line with
  `sh deploy/web/csp.sh stagenet /sponsor` after an upgrade, and add the origins of any network
  overrides you put in `config.json` to its `connect-src`, or the browser blocks them. nginx drops the
  server's `add_header` lines in a `location` that has its own, so add none there. HSTS is set here:
  this nginx terminates TLS.
- **Separate from MN Bank's users.** Browser storage is per origin: swap records on this site are not
  on MN Bank's, and the other way round.

## 7. The sponsor wallet

The wallet tool runs as `emt`, with the same settings as the units. The proof server must be up
(`register-dust` proves one transaction), and **the sponsor must be down**, because only one process
may hold the wallet:

```bash
emt-tool() { sudo systemd-run --quiet --pty --wait --collect --uid=emt --gid=emt \
  -p WorkingDirectory=/opt/emt/app -p EnvironmentFile=/etc/emt/sponsor.env \
  /usr/local/bin/bun sponsor/src/tools/sponsor-wallet.ts "$@"; }
emt-tool new --out /srv/emt/secrets/sponsor.seed --network stagenet   # a NEW wallet: prints its NIGHT address
emt-tool address --seed-file /srv/emt/secrets/sponsor.seed --network stagenet
# fund it with NIGHT from .stagenet (under ~/.stagenet-offer-ladders/funding.lock), in several transfers
emt-tool register-dust          # one transaction; run it again after every NIGHT top-up
emt-tool status                 # NIGHT, how much is registered, DUST, ceiling and daily income
```

`new` never overwrites a file, writes mode 600, and prints only the public address. Back the seed up
like any wallet seed. `systemd-run` talks to systemd over D-Bus, which a standard Debian server has
(`Failed to connect to bus` means `sudo apt-get install dbus`).

**DUST economics** (RUNBOOK section 4):

- Registered NIGHT makes about **0.714 DUST per NIGHT per day**, up to 5 DUST per NIGHT.
- **A swap costs about 4.7 DUST** (4.66 and 4.70 measured live); the take is paid by the batcher.
- Example: 200 NIGHT gives about 143 DUST a day, about 30 swaps a day.
- Below 10 DUST new swaps are refused; the stale closer keeps a 20 DUST reserve.

## 8. Firewall

- **Inbound: only 22, 80 and 443**, as for MN Bank.
- **The proof server listens on `0.0.0.0:6300`** (it has no bind option) and answers any web origin
  (it reflects CORS). If 6300 were reachable from outside, anyone could use it: memory and CPU for
  their proofs, and MN Bank's and this app's proofs waiting behind them. If the host already has its
  firewall (MN Bank's guide allows only 22, 80 and 443 in), check that it covers 6300; otherwise, for
  example with ufw (22 is allowed before the firewall is enabled):

  ```bash
  sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
  sudo ufw enable && sudo ufw status verbose
  ```

  Then check from **another** machine that `curl -m 5 http://<server>:6300/version` fails.
  (A second proof server on 6301, step 2, needs the same.)
- **The sponsor listens on `127.0.0.1:8091`** and MN Bank's relay on `127.0.0.1:8080`: nothing to
  open. Only nginx reaches them.
- **Outbound**: the list at the top. The sponsor adds no new destination to MN Bank's.

## 9. Launch, in order, and health checks

```bash
# 0. The shared proof server is up (step 2).
curl -s http://127.0.0.1:6300/version                      # 9.0.0-rc.6

# 1. The units.
sudo systemctl daemon-reload
sudo systemctl enable emt-vault-keys emt-sponsor

# 2. The key directory: the first time compiles (minutes). Watch: journalctl -fu emt-vault-keys
sudo systemctl start emt-vault-keys
systemctl is-active emt-vault-keys                         # active (RemainAfterExit)

# 3. The sponsor wallet: new, fund, register-dust (step 7).

# 4. The sponsor. Its wallet syncs from genesis in about 2 minutes.
sudo systemctl start emt-sponsor
curl -s http://127.0.0.1:8091/v1/health                   # "status":"ok" once synced

# 5. The site.
sudo ln -s /etc/nginx/sites-available/emt /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
curl -s https://swap.example.com/config.json               # {"network":"stagenet","sponsorUrl":"/sponsor"}
curl -s https://swap.example.com/sponsor/v1/config | head -c 400   # the vault 7771c9e5…, the two signing domains
curl -sI https://swap.example.com/ | grep -i -E 'x-frame|nosniff|referrer|permissions'

# 6. MN Bank is unchanged.
curl -s http://127.0.0.1:8080/health                       # MN Bank's relay: still ok, its proofServer still reachable
```

**Reading `/v1/health`** (every field: RUNBOOK section 8). Before opening the site, expect:
`"status":"ok"`, `sponsor.state: "synced"`, `sponsor.dustLow: false`, `proofServer.version:
"9.0.0-rc.6"`, `bridge.available: true`, `bridge.keysVerified: true`, `vaultGas.low: false`.

- `degraded`: a warning; the sponsor serves what it can. Causes: the wallet is syncing or low on DUST,
  the vault gas is low, the kernel or batcher is unreachable, the proof server's version differs, or
  the bridge is not loaded.
- `down` (HTTP 503): the proof server is unreachable, or the sponsor wallet is in error.

Logs: `journalctl -u emt-sponsor -f` (JSON lines). They never contain a secret.

**Before opening the site**:

1. **The vault's Sepolia gas account** `0x648216975e722494bFF92E88FFc68C8F8d438FaA` pays every
   withdrawal, MN Bank's and this app's. `vaultGas` in either service's health shows it; keep it
   above 0.002 ETH (RUNBOOK section 7).
2. **Tell MN Bank's users** that their withdrawals can be asked to "try again in a few minutes" while
   this app's withdrawals run (RUNBOOK section 9).
3. **Smoke test**: open the site; the offers list shows the live offers whose two legs the vault
   bridges; connect a wallet on Sepolia. A full swap spends real test funds and about 5 DUST: run one
   only when you mean to (RUNBOOK section 11).

## 10. Updating

Stop the sponsor, update both checkouts to the same commit, then start it again. Every swap in flight
resumes from `swaps.json` (RUNBOOK section 14.1); prefer a moment when `queue.lanes.withdrawal` shows 0
running and 0 waiting.

```bash
sudo cp /var/lib/emt/sponsor-data/swaps.json /var/lib/emt/swaps-$(date -u +%F).json   # a backup
for d in /opt/emt/app /var/lib/emt/web-src; do (cd $d && sudo -u emt -H git fetch && sudo -u emt -H git checkout <commit>); done
(cd /opt/emt/app && sudo -u emt -H bun install --frozen-lockfile --production --ignore-scripts)
sudo sed -i 's/^SPONSOR_VERSION=.*/SPONSOR_VERSION=<commit>/' /etc/emt/sponsor.env
sudo systemctl restart emt-vault-keys emt-sponsor   # the keys only re-verify
# then redo the web lines of step 6 (bun install, build:web, copy, the .map cleanup, config.json)
```

Update the web and the sponsor together. If the new version changed a key input (the vault commit,
compactc, the Signet module), refresh `/opt/emt/vault-src` (step 1) and rebuild the key directory with
the sponsor stopped: `sudo systemctl stop emt-sponsor`, move `/opt/emt/app/vault-managed` aside, then
`sudo systemctl restart emt-vault-keys` (with no `IMPORT_DIR` set, it compiles into the empty
directory) and start the sponsor.

**A proof server upgrade is a joint upgrade** with MN Bank: the two services move to the new SDK set
together, or this sponsor gets its own proof server first (step 2).

## What was tested

| Check | Result |
|---|---|
| The Compose bundle, live (plan 00048 P3): the same sponsor, web and key job this layout runs natively | **PASS** on stagenet and Sepolia (RUNBOOK section 16) |
| The proof server's defaults: `midnight-proof-server --help` of the pinned rc.6 image, run offline | 2 workers, a 10-job queue, a 600 s job timeout |
| That the sponsor can share the proof server | **From the code**, not from a shared run: step 2 |
| `systemd-analyze verify` on `emt-vault-keys`, `emt-sponsor`, the `emt-proof-server` sketch and MN Bank's `mnbank-proof-server` (Debian 12, systemd 252) | Clean |
| `emt-vault-keys` under a running systemd (Debian 12 container, systemd 252 as PID 1), with the real `build.sh`, the real pinned vault sources, and stand-ins for Bun and compactc | `BindPaths=` gave the script this checkout at `/app` and the sources at `/src/vault`, as `emt`. `ensure` compiled (the sources' SHA-256 checked) and installed at `/opt/emt/app/vault-managed`; a restart only verified; `IMPORT_DIR` imported. A changed source failed the unit (`… is not the pinned source`), and **`emt-sponsor` then refused to start**. MN Bank's `/app` was untouched |
| `emt-sponsor`'s sandbox, with a stand-in for the sponsor | Runs as `emt` in `/opt/emt/app` with every setting of step 3; reads its own seed, RPC file and key directory; **cannot read MN Bank's seed**; writes only `/var/lib/emt`; `/home` hidden; `MemoryMax=4G` |
| The wallet tool wrapper of step 7 (`systemd-run`) | Ran the tool as `emt`, in the checkout, with the settings file |
| The nginx site, with MN Bank's site enabled beside it (Debian 12's nginx 1.22.1, self-signed certificates, stand-in upstreams) | `nginx -t` clean (the two `log_format` names coexist). `/sponsor/v1/health?x=1` reached the sponsor as `GET /v1/health?x=1`, and a spoofed `X-Forwarded-For` was replaced by the client's address. `config.json` served as JSON, not cached. The four security headers on pages, `config.json` and proxied answers. SPA fallback, 30-day asset cache, missing asset 404, `.wasm` as `application/wasm`, HTTP to HTTPS redirect, a 3 MB body refused (413), no query strings in the log. MN Bank's site and `/relay/` unchanged |
| Bun install, the key compile and verify, the sponsor's start | The same commands the tested images run. **Not run natively** |
| The whole layout on a real host next to a running MN Bank, and two services proving on one proof server | **Not tested** |

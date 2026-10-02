#!/usr/bin/env bash
# Plan 00048 P3: the live end-to-end runs through the DEPLOYED bundle (deploy/compose.yml) on
# Midnight stagenet and Sepolia, within the Q8 caps. Nothing here builds or runs the sponsor from
# source: the sponsor, the web site, the proof server and the vault key job are the bundle's own
# services, configured by an env file this script writes into the state directory.
#
#   run-live.sh env                       write the bundle's env file (free ports >= 10000, image tag,
#                                         the secret files' PATHS; never a secret value)
#   run-live.sh preflight                 stagenet node version, Sepolia balances (user, vault EVM
#                                         account), Docker memory and disk, the live book
#   run-live.sh build                     docker compose build (the sponsor, web and key-job images)
#   run-live.sh keys                      the vault key job: compile + verify against the chain
#   run-live.sh up                        proof server; the funding lock (held until stop/down);
#                                         sponsor + web; wait until the sponsor wallet has synced
#   run-live.sh stop | start              stop the sponsor and release the lock | take it and start
#   run-live.sh health <name>             the sponsor's /v1/health -> evidence <name>.json
#   run-live.sh phase <e2|e3> <offerId> [import]   the Playwright phase, in the web container's
#                                         network namespace (the site is http://127.0.0.1:8080); e2 with
#                                         an export file (in the state directory) continues that swap
#   run-live.sh temp-check <salt> <name> [derivation]   the swap's temporary wallet, re-derived in-process
#                                            (the record's salt and derivation; P3's swaps: salt = id, 1)
#   run-live.sh competitor-fund <offerId> E.3: the G-TAKE gate's `fund` for a competitor wallet
#                                         (derived from the test EVM key with its own salt; the
#                                         funding wallet sends exactly the offer's wanted amount).
#                                         The gate takes and releases the funding lock itself: run it
#                                         while THIS script does not hold the lock (before `up`)
#   run-live.sh competitor-take <offerId> E.3: the competitor takes the offer through the batcher
#   run-live.sh logs                      the sponsor's logs -> the state directory (not evidence)
#   run-live.sh down                      compose down -v, the lock released, the gate removed
#
# Secrets are FILES, never values: the sponsor seed (`.stagenet`, WALLET=; SHARED: only while this
# script holds ~/.stagenet-offer-ladders/funding.lock) is a Compose secret of the sponsor, and the
# test EVM key (`.sepolia`, SK=) is mounted read-only into the Playwright runner, which reads it
# in-process. The Sepolia RPC is a public endpoint; its URL file lives in the state directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CMD="${1:?usage: run-live.sh env|preflight|build|keys|up|stop|start|sponsor-stop|sponsor-start|sponsor-outage|grief|health|phase|temp-check|competitor-fund|competitor-take|logs|down}"
shift || true

P=aa00048-p3
CHECK="$P-check"
STATE="${LIVE_STATE_DIR_HOST:-$HOME/.config/aa-00048/p3}"
ENVF="$STATE/bundle.env"
EVIDENCE="${LIVE_EVIDENCE_DIR_HOST:-/Users/edwardalvarado/todo/AA/evidence/00048-evm-midnight-transparent/p3}"
SEED_FILE="${STAGENET_SECRET_FILE:-/Users/edwardalvarado/todo/Offer Files/.stagenet}"
SEPOLIA_FILE="${SEPOLIA_SECRET_FILE:-/Users/edwardalvarado/todo/Offer Files/.sepolia}"
LOCK="$HOME/.stagenet-offer-ladders/funding.lock"
RPC="https://ethereum-sepolia-rpc.publicnode.com"
EXPECTED_NODE="2.0.0-d9729c13"
PW_IMAGE="mcr.microsoft.com/playwright:v1.62.0-noble"
RUNNER_IMAGE="node:24-bookworm-slim"

say() { printf '== [%s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
mkdir -p "$STATE/logs" "$EVIDENCE" && chmod 700 "$STATE" "$STATE/logs" "$(dirname "$STATE")"

DC=(docker compose -f "$ROOT/deploy/compose.yml" --env-file "$ENVF" -p "$P")
envv() { grep -E "^$1=" "$ENVF" | head -1 | cut -d= -f2-; }

free_port() {
  python3 - <<'PY'
import random, socket
for _ in range(200):
    p = random.randint(10000, 60000)
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", p)); s.close(); print(p); break
    except OSError:
        s.close()
PY
}

rpc() { # <method> <json params>
  curl -fsS --max-time 30 -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])'
}

node_version() {
  curl -fsS --max-time 30 -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"system_version","params":[]}' https://rpc.stagenet.shielded.tools |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])'
}

headroom_gb() {
  docker stats --no-stream --format '{{.MemUsage}}' | python3 -c '
import re, sys
unit = {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "KB": 1e3, "MB": 1e6, "GB": 1e9}
used, total = 0.0, 0.0
for line in sys.stdin:
    a, b = [s.strip() for s in line.split("/")]
    m, n = re.match(r"([\d.]+)(\w+)", a), re.match(r"([\d.]+)(\w+)", b)
    used += float(m.group(1)) * unit[m.group(2)]
    total = max(total, float(n.group(1)) * unit[n.group(2)])
print(int((total - used) / 2**30) if total else 99)'
}
disk_gb() { docker run --rm alpine:3.22 df -k / | awk 'NR==2 {print int($4/1024/1024)}'; }

# Another container (not ours) with the funding wallet mounted: it is driving that wallet now.
seed_mounted_elsewhere() {
  local ids
  ids="$(docker ps -q)"
  [[ -n "$ids" ]] || return 1
  docker inspect --format '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' $ids 2>/dev/null |
    grep -v "^/$P-" | grep -F "/Offer Files/.stagenet" >/dev/null
}

# Another process or container (not ours) that may send from the test EVM user (`.sepolia`): two
# senders on one account collide on its nonce (and a delegated account has one pending transaction).
sepolia_in_use() {
  local ids
  if ps -axo command | grep -E 'Offer Files/\.sepolia|deposit-fund|gates/bridge/gate\.ts fund' | grep -v grep >/dev/null; then return 0; fi
  ids="$(docker ps -q)"
  [[ -n "$ids" ]] || return 1
  docker inspect --format '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' $ids 2>/dev/null |
    grep -v "^/$P-" | grep -F "/Offer Files/.sepolia" >/dev/null
}

lock_take() {
  mkdir -p "$(dirname "$LOCK")"
  if [[ -s "$STATE/lock-holder.pid" ]] && grep -q "\"pid\":$(cat "$STATE/lock-holder.pid")," "$LOCK" 2>/dev/null; then
    say "the funding lock is already ours"
    return 0
  fi
  for i in $(seq 1 31); do
    if [[ ! -e "$LOCK" ]] && ! seed_mounted_elsewhere; then
      nohup sleep 86400 >/dev/null 2>&1 &
      local holder=$!
      if (set -o noclobber; printf '{"purpose":"aa-00048 P3 live end-to-end (the %s-sponsor holds the wallet)","pid":%s,"host":"%s","at":"%s"}' \
        "$P" "$holder" "$(hostname)" "$(date -u +%FT%TZ)" >"$LOCK") 2>/dev/null; then
        chmod 600 "$LOCK"
        echo "$holder" >"$STATE/lock-holder.pid"
        say "funding lock taken (holder pid $holder)"
        return 0
      fi
      kill "$holder" 2>/dev/null || true
    fi
    [[ "$i" == 31 ]] && { say "the funding wallet is still busy after 30 min: $(cat "$LOCK" 2>/dev/null || echo 'a container has it mounted')"; return 75; }
    say "the funding wallet is busy ($(cat "$LOCK" 2>/dev/null || echo 'a container has it mounted')); waiting 60 s ($i/30)"
    sleep 60
  done
}

lock_release() {
  if [[ -s "$STATE/lock-holder.pid" ]]; then
    local holder
    holder="$(cat "$STATE/lock-holder.pid")"
    if grep -q "\"pid\":$holder," "$LOCK" 2>/dev/null; then
      rm -f "$LOCK"
      say "funding lock released"
    fi
    kill "$holder" 2>/dev/null || true
    rm -f "$STATE/lock-holder.pid"
  fi
}

sponsor_health() { curl -fsS --max-time 30 "http://127.0.0.1:$(envv SPONSOR_HOST_PORT)/v1/health"; }

wait_synced() {
  for _ in $(seq 1 120); do
    if sponsor_health 2>/dev/null | python3 -c '
import json, sys
h = json.load(sys.stdin)
s = h.get("sponsor") or {}
ok = bool(s.get("synced")) and (h.get("bridge") or {}).get("keysVerified") is not False
sys.exit(0 if ok else 1)' 2>/dev/null; then
      say "the sponsor wallet has synced"
      return 0
    fi
    sleep 5
  done
  say "the sponsor did not sync in 10 minutes"
  return 1
}

sync_tree() {
  DOCKER_CHECK_NAME="$CHECK" "$ROOT/scripts/docker-check.sh" up >/dev/null
  DOCKER_CHECK_NAME="$CHECK" "$ROOT/scripts/docker-check.sh" sync
}

gate() { # the G-TAKE gate for the E.3 competitor: its own salt, state and evidence folders
  GATE_PREFIX="$P-gt" DOCKER_CHECK_NAME="$CHECK" GATE_STATE_DIR="$STATE/competitor" \
    GATE_EVIDENCE_DIR="$EVIDENCE/e3-competitor" SEPOLIA_SECRET_FILE="$SEPOLIA_FILE" \
    STAGENET_SECRET_FILE="$SEED_FILE" bash "$ROOT/test/gates/take/run-gate.sh" "$@"
}

[[ "$CMD" == env || -f "$ENVF" ]] || { say "no env file yet: run 'run-live.sh env' first"; exit 2; }

case "$CMD" in
  env)
    [[ -f "$ENVF" ]] && { say "$ENVF exists (delete it to choose new ports)"; exit 0; }
    printf '%s\n' "$RPC" >"$STATE/sepolia-rpc-url" && chmod 600 "$STATE/sepolia-rpc-url"
    {
      echo "# Written by test/live/run-live.sh env (plan 00048 P3). Paths only, never a secret value."
      echo "COMPOSE_PROJECT_NAME=$P"
      echo "IMAGE_TAG=$P"
      echo "WEB_BIND_ADDRESS=127.0.0.1"
      echo "WEB_HOST_PORT=$(free_port)"
      echo "SPONSOR_HOST_PORT=$(free_port)"
      echo "SPONSOR_ENV_FILE=$ENVF"
      echo "SPONSOR_SEED_HOST_FILE=$SEED_FILE"
      echo "SEPOLIA_RPC_URL_HOST_FILE=$STATE/sepolia-rpc-url"
      echo "# The seed is SHARED: run-live.sh holds ~/.stagenet-offer-ladders/funding.lock on the host for"
      echo "# as long as the sponsor runs, so the sponsor may treat it as its own."
      echo "SPONSOR_DEDICATED_WALLET=true"
      echo "SPONSOR_FEE_BLOCKS_MARGIN=20"
      echo "SPONSOR_NETWORK=stagenet"
      echo "PROOF_SERVER_MEM_LIMIT=10g"
      echo "SPONSOR_MEM_LIMIT=4g"
      echo "WEB_MEM_LIMIT=256m"
      echo "VAULT_KEYS_JOB_MEM_LIMIT=8g"
      echo "APP_NAME=EVM Midnight Swap"
      echo "LOG_LEVEL=info"
      echo "SPONSOR_TRUST_PROXY=true"
    } >"$ENVF"
    chmod 600 "$ENVF"
    say "wrote $ENVF (web 127.0.0.1:$(envv WEB_HOST_PORT), sponsor 127.0.0.1:$(envv SPONSOR_HOST_PORT))"
    ;;

  preflight)
    version="$(node_version)"
    say "stagenet system_version $version (expected $EXPECTED_NODE)"
    python3 - "$EVIDENCE/00-preflight.json" "$version" "$EXPECTED_NODE" "$(headroom_gb)" "$(disk_gb)" <<'PY'
import json, sys, urllib.request
out, version, expected, headroom, disk = sys.argv[1:6]
RPC = "https://ethereum-sepolia-rpc.publicnode.com"
def call(m, p):
    r = urllib.request.Request(RPC, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": m, "params": p}).encode(),
                               headers={"content-type": "application/json", "user-agent": "curl/8"})
    return json.load(urllib.request.urlopen(r, timeout=30))["result"]
U = "0x484738A67858305Edfc139B194Ed430Fe4D8e56b"; V = "0x648216975e722494bFF92E88FFc68C8F8d438FaA"
tok = {"USDC": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", "stkA": "0x2Ab7BE0769e3BBD5c7d047B422CB383fCC06FB52"}
bal = {"ETH": str(int(call("eth_getBalance", [U, "latest"]), 16))}
for n, a in tok.items():
    bal[n] = str(int(call("eth_call", [{"to": a, "data": "0x70a08231" + U[2:].lower().rjust(64, "0")}, "latest"]), 16))
vault_eth = int(call("eth_getBalance", [V, "latest"]), 16)
book = json.load(urllib.request.urlopen(urllib.request.Request("https://stagenet.api-zswap.zkdojo.com/v1/offers?limit=100",
                                                             headers={"user-agent": "curl/8"}), timeout=30))
offers = [{"offerId": o["offerId"], "gives": o["computed"]["gives"], "wants": o["computed"]["wants"],
           "expiresAt": o["computed"].get("expiresAt")} for o in book.get("offers", []) if o["computed"].get("status") == "live"]
res = {"plan": "00048 P3", "stagenetNodeVersion": version, "expectedNodeVersion": expected, "nodeVersionOk": version == expected,
       "sepoliaUser": U, "userBalances": bal, "vaultEvmAccount": V, "vaultEvmWei": str(vault_eth),
       "vaultEvmAtLeast0_001ETH": vault_eth >= 10**15, "dockerHeadroomGb": int(headroom), "dockerDiskFreeGb": int(disk),
       "liveOffers": offers}
json.dump(res, open(out, "w"), indent=2); open(out, "a").write("\n")
print(json.dumps({k: v for k, v in res.items() if k != "liveOffers"}, indent=2), f"\nlive offers: {len(offers)}")
PY
    ;;

  build)
    free="$(disk_gb)"; say "Docker disk free ${free} GB"; [[ "$free" -ge 6 ]] || { say "under 6 GB free: stop"; exit 3; }
    "${DC[@]}" build vault-keys sponsor web 2>&1 | tee "$STATE/logs/build.log" | grep -E 'Built|ERROR|error' | tail -20
    ;;

  keys)
    free="$(disk_gb)"; say "Docker disk free ${free} GB"; [[ "$free" -ge 4 ]] || exit 3
    h="$(headroom_gb)"; say "Docker memory headroom ${h} GB"; [[ "$h" -ge 8 ]] || exit 75
    "${DC[@]}" up vault-keys 2>&1 | tee "$STATE/logs/vault-keys.log" | tail -20
    [[ "$(docker inspect -f '{{.State.ExitCode}}' "$P-vault-keys-1")" == 0 ]] || { say "the key job failed"; exit 1; }
    ;;

  up)
    version="$(node_version)"; say "stagenet system_version $version"
    [[ "$version" == "$EXPECTED_NODE" ]] || { say "stagenet runs $version, expected $EXPECTED_NODE: stop"; exit 3; }
    h="$(headroom_gb)"; say "Docker memory headroom ${h} GB"; [[ "$h" -ge 8 ]] || exit 75
    "${DC[@]}" up -d proof-server
    lock_take
    "${DC[@]}" up -d sponsor web
    wait_synced || { lock_release; exit 1; }
    sponsor_health | python3 -m json.tool | head -60
    ;;

  stop)
    "${DC[@]}" stop sponsor
    docker logs "$P-sponsor-1" >"$STATE/logs/sponsor-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 || true
    lock_release
    ;;

  start)
    version="$(node_version)"; say "stagenet system_version $version"
    [[ "$version" == "$EXPECTED_NODE" ]] || { say "stagenet runs $version, expected $EXPECTED_NODE: stop"; exit 3; }
    lock_take
    "${DC[@]}" start sponsor
    wait_synced || { lock_release; exit 1; }
    ;;

  health)
    name="${1:?name}"
    sponsor_health | python3 -c "import json,sys; h=json.load(sys.stdin); print(json.dumps({'plan': '00048 P3', 'at': '$(date -u +%FT%TZ)', 'health': h}, indent=2))" >"$EVIDENCE/$name.json"
    cat "$EVIDENCE/$name.json"
    ;;

  phase)
    name="${1:?phase: e2|e3}"
    offer="${2:?offerId}"
    import="${3:-}" # e2 only: a swap record export file in the state directory (continue that swap)
    [[ -s "$STATE/lock-holder.pid" ]] || { say "the funding lock is not held: run 'up' first"; exit 2; }
    for i in $(seq 1 16); do
      if ! sepolia_in_use; then break; fi
      [[ "$i" == 16 ]] && { say "another sender from the test EVM user is still active after 30 min"; exit 75; }
      say "another process uses the test EVM user's key; waiting 120 s ($i/15)"; sleep 120
    done
    sync_tree >/dev/null
    rm -f "$STATE/e3-ready.json"
    docker rm -f "$P-live-$name" >/dev/null 2>&1 || true
    log="$STATE/logs/phase-$name-$(date -u +%Y%m%dT%H%M%SZ).log"
    say "phase $name on offer $offer (log $log)"
    set +e
    docker run --rm --name "$P-live-$name" --network "container:$P-web-1" --init --memory 4g \
      -v "$CHECK-app:/app" -v "$CHECK-bun:/opt/bun:ro" \
      -v "$SEPOLIA_FILE:/secrets/sepolia:ro" -v "$STATE:/live" -v "$EVIDENCE:/evidence" \
      -e PATH=/opt/bun:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e CI=1 -e HOME=/root \
      -e LIVE_BASE_URL=http://127.0.0.1:8080 -e LIVE_PHASE="$name" -e LIVE_OFFER_ID="$offer" \
      -e LIVE_STATE_DIR=/live -e LIVE_OUT_DIR=/evidence -e LIVE_KEY_FILE=/secrets/sepolia -e LIVE_SEPOLIA_RPC="$RPC" \
      ${import:+-e LIVE_IMPORT_FILE="/live/$import"} \
      -w /app "$PW_IMAGE" npx playwright test -c test/live/live.config.ts --reporter=list >"$log" 2>&1
    status=$?
    set -e
    tail -30 "$log" >&2
    exit "$status"
    ;;

  temp-check)
    salt="${1:?salt}"
    name="${2:-temp-check}"
    derivation="${3:-2}"
    sync_tree >/dev/null
    docker run --rm --name "$P-temp-check" --init -v "$CHECK-app:/app" -v "$CHECK-bun:/opt/bun:ro" \
      -v "$SEPOLIA_FILE:/secrets/sepolia:ro" -v "$EVIDENCE:/evidence" \
      -e LIVE_KEY_FILE=/secrets/sepolia -e LIVE_OUT_DIR=/evidence -w /app "$RUNNER_IMAGE" \
      /opt/bun/bun test/live/temp-check.ts "$salt" "$name" "$derivation"
    ;;

  competitor-fund)
    offer="${1:?offerId}"
    [[ -s "$STATE/lock-holder.pid" ]] && { say "this script holds the funding lock (the sponsor runs): 'stop' first"; exit 2; }
    mkdir -p "$STATE/competitor" "$EVIDENCE/e3-competitor" && chmod 700 "$STATE/competitor"
    gate derive
    gate fund "$offer"
    ;;

  competitor-take)
    offer="${1:?offerId}"
    gate take "$offer"
    ;;

  logs)
    docker logs "$P-sponsor-1" >"$STATE/logs/sponsor-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 || true
    say "sponsor log saved in $STATE/logs"
    ;;

  sponsor-stop)
    # E.5: pause the sponsor WITHOUT releasing the funding lock (the holder process from `up` keeps
    # it). The griefer then uses the shared seed alone while the sponsor is down.
    [[ -s "$STATE/lock-holder.pid" ]] || { say "the funding lock is not held: run 'up' first"; exit 2; }
    docker logs "$P-sponsor-1" >"$STATE/logs/sponsor-prepause-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 || true
    docker stop "$P-sponsor-1"
    say "sponsor container stopped; the funding lock stays held by this script (holder pid $(cat "$STATE/lock-holder.pid"))"
    ;;

  sponsor-start)
    docker start "$P-sponsor-1"
    wait_synced || { say "the sponsor did not re-sync after restart"; exit 1; }
    say "sponsor restarted and synced"
    ;;

  sponsor-outage)
    # E.7 (P4.5 live): a passing sponsor outage. Stop the sponsor container (the lock stays held),
    # wait <seconds> (default 120), start it again and wait until it has re-synced.
    secs="${1:-120}"
    [[ -s "$STATE/lock-holder.pid" ]] || { say "the funding lock is not held: run 'up' first"; exit 2; }
    docker logs "$P-sponsor-1" >"$STATE/logs/sponsor-preoutage-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 || true
    docker stop "$P-sponsor-1" >/dev/null
    say "sponsor stopped (outage starts; lock kept, holder pid $(cat "$STATE/lock-holder.pid")); waiting ${secs} s"
    sleep "$secs"
    docker start "$P-sponsor-1" >/dev/null
    say "sponsor started again; waiting for its wallet to re-sync"
    wait_synced || { say "the sponsor did not re-sync after the outage"; exit 1; }
    say "sponsor back (outage over)"
    ;;

  grief)
    # E.5: the griefer completes the swap's own deposit with its own encryption key and mint nonce
    # (test/live/griefer.ts; it reuses sponsor/src/bridge). Inputs come from $STATE/e5-ready.json
    # (public), written by the e5 Playwright phase. It pays DUST from `.stagenet` under the lock this
    # script holds; run it only while the sponsor is stopped (sponsor-stop).
    [[ -s "$STATE/lock-holder.pid" ]] || { say "the funding lock is not held: run 'up' first"; exit 2; }
    [[ -s "$STATE/e5-ready.json" ]] || { say "no $STATE/e5-ready.json yet (run 'phase e5' first)"; exit 2; }
    if docker inspect -f '{{.State.Running}}' "$P-sponsor-1" 2>/dev/null | grep -q true; then
      say "the sponsor is still running: 'sponsor-stop' first so only the griefer uses the seed"; exit 2
    fi
    tcp="$(python3 -c "import json;print(json.load(open('$STATE/e5-ready.json'))['tempCoinPk'])")"
    dep="$(python3 -c "import json;print(json.load(open('$STATE/e5-ready.json'))['depositAddress'])")"
    sym="$(python3 -c "import json;print(json.load(open('$STATE/e5-ready.json')).get('paySymbol') or 'stkA')")"
    sync_tree >/dev/null
    log="$STATE/logs/grief-$(date -u +%Y%m%dT%H%M%SZ).log"
    say "griefer: completing the deposit for temp coin pk ${tcp:0:12}… ($sym), log $log"
    set +e
    docker run --rm --name "$P-grief" --network "container:$P-proof-server-1" --init --memory 6g \
      -v "$CHECK-app:/app" -v "$CHECK-bun:/opt/bun:ro" \
      -v "${P}_vault-keys:/app/vault-managed:ro" \
      -v "$SEED_FILE:/secrets/stagenet:ro" -v "$STATE:/live" -v "$EVIDENCE:/evidence" \
      -e PATH=/opt/bun:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin -e HOME=/root \
      -e STAGENET_WALLET_FILE=/secrets/stagenet -e VAULT_MANAGED_DIR=/app/vault-managed \
      -e PROOF_SERVER_URL=http://127.0.0.1:6300 -e SEPOLIA_RPC_URL="$RPC" \
      -e GRIEF_EVIDENCE_DIR=/evidence -e FEE_BLOCKS_MARGIN=20 \
      -w /app "$RUNNER_IMAGE" /opt/bun/bun test/live/griefer.ts \
      --temp-coin-pk "$tcp" --deposit-address "$dep" --token "$sym" --name e5-grief 2>&1 | tee "$log"
    status="${PIPESTATUS[0]}"
    set -e
    exit "$status"
    ;;

  down)
    docker logs "$P-sponsor-1" >"$STATE/logs/sponsor-final-$(date -u +%Y%m%dT%H%M%SZ).log" 2>&1 || true
    "${DC[@]}" down -v --remove-orphans
    lock_release
    gate down || true
    ;;

  *)
    echo "unknown command $CMD" >&2
    exit 64
    ;;
esac

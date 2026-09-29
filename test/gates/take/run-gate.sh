#!/usr/bin/env bash
# G-TAKE host orchestration (plan 00048, P1): the proof server and each gate step, in Docker.
#
#   test/gates/take/run-gate.sh up                 network + proof server 9.0.0-rc.6 (own params volume,
#                                                  a random free host port >= 10000)
#   test/gates/take/run-gate.sh derive             T.1 live (the test EVM key signs twice)
#   test/gates/take/run-gate.sh fund <offerId>     T.2, holding the shared funding lock only while it runs
#   test/gates/take/run-gate.sh take <offerId>     T.3 + T.4 (no funding wallet: the batcher pays the fee)
#   test/gates/take/run-gate.sh measure-sync       T.4, a fresh seed's shielded-only sync in Bun
#   test/gates/take/run-gate.sh status             the temporary wallet's balances
#   test/gates/take/run-gate.sh down               remove the gate's containers, network and volumes
#
# The steps run with Bun inside the repository's Docker check volume (scripts/docker-check.sh,
# DOCKER_CHECK_NAME=aa00048-gt-check), which `run-gate.sh` syncs first. Secrets are bind-mounted
# READ-ONLY and read in-process by gate.ts: the test EVM key for every step, the funding wallet only
# for `fund`. Nothing secret is printed. Evidence (public values) goes to GATE_EVIDENCE_DIR; the
# gate's public state (the swap salt, the funded offer) to GATE_STATE_DIR (mode 700).
#
# Environment (defaults are the owner's layout; see plan 00048's header table):
#   SEPOLIA_SECRET_FILE   the test EVM key file (SK=)
#   STAGENET_SECRET_FILE  the funding wallet file (WALLET=), shared: the funding lock is taken first
#   FUNDING_LOCK          the shared lock file (O_EXCL, never stolen; waits up to LOCK_WAIT seconds)
#   GATE_EVIDENCE_DIR     public evidence
#   GATE_STATE_DIR        public gate state (salt, offer), mode 700
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
P="${GATE_PREFIX:-aa00048-gt}"
NETWORK="$P-net"
PROVER="$P-prover"
PARAMS="$P-params"
GATE="$P-gate"
CHECK="${DOCKER_CHECK_NAME:-$P-check}"
RUNNER_IMAGE="${RUNNER_IMAGE:-node:24-bookworm-slim}"
PROOF_IMAGE="midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b"
SEPOLIA_SECRET_FILE="${SEPOLIA_SECRET_FILE:-$HOME/todo/Offer Files/.sepolia}"
STAGENET_SECRET_FILE="${STAGENET_SECRET_FILE:-$HOME/todo/Offer Files/.stagenet}"
FUNDING_LOCK="${FUNDING_LOCK:-$HOME/.stagenet-offer-ladders/funding.lock}"
LOCK_WAIT="${LOCK_WAIT:-3600}"
GATE_EVIDENCE_DIR="${GATE_EVIDENCE_DIR:?set GATE_EVIDENCE_DIR (public evidence folder)}"
GATE_STATE_DIR="${GATE_STATE_DIR:-$HOME/.config/aa-00048}"
PORT_FILE="$GATE_STATE_DIR/g-take-prover-port"

say() { printf '== %s\n' "$*" >&2; }

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

up() {
  docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
  if [[ "$(docker inspect -f '{{.State.Running}}' "$PROVER" 2>/dev/null)" != true ]]; then
    docker rm -f "$PROVER" >/dev/null 2>&1 || true
    docker volume create "$PARAMS" >/dev/null
    local port
    port="$(free_port)"
    mkdir -p "$GATE_STATE_DIR" && chmod 700 "$GATE_STATE_DIR"
    echo "$port" >"$PORT_FILE"
    # The params directory is the proof server's own writable volume: it fetches the public
    # parameters and the zswap/DUST keys there at start.
    docker run -d --name "$PROVER" --network "$NETWORK" -p "127.0.0.1:$port:6300" \
      --memory 8g --cap-drop ALL --security-opt no-new-privileges:true \
      -e PORT=6300 -e MIDNIGHT_PP=/proof-params -v "$PARAMS:/proof-params" "$PROOF_IMAGE" >/dev/null
    say "proof server $PROVER on 127.0.0.1:$port (network $NETWORK)"
  fi
  local port
  port="$(cat "$PORT_FILE")"
  for i in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:$port/version" >/dev/null 2>&1; then
      say "proof server ready: $(curl -fsS "http://127.0.0.1:$port/version")"
      return 0
    fi
    sleep 2
  done
  say "the proof server did not answer /version"
  docker logs --tail 30 "$PROVER" >&2
  return 1
}

sync_tree() {
  DOCKER_CHECK_NAME="$CHECK" "$ROOT/scripts/docker-check.sh" up >/dev/null
  DOCKER_CHECK_NAME="$CHECK" "$ROOT/scripts/docker-check.sh" sync
}

gate() { # <with-funding-wallet: 0|1> <gate.ts args...>
  local funding="$1"
  shift
  [[ -r "$SEPOLIA_SECRET_FILE" ]] || { say "cannot read the test EVM key file"; return 2; }
  mkdir -p "$GATE_EVIDENCE_DIR" "$GATE_STATE_DIR" && chmod 700 "$GATE_STATE_DIR"
  local mounts=(-v "$CHECK-app:/app" -v "$CHECK-bun:/opt/bun:ro"
    -v "$SEPOLIA_SECRET_FILE:/run/secrets/sepolia:ro"
    -v "$GATE_STATE_DIR:/state" -v "$GATE_EVIDENCE_DIR:/out")
  if [[ "$funding" == 1 ]]; then
    [[ -r "$STAGENET_SECRET_FILE" ]] || { say "cannot read the funding wallet file"; return 2; }
    mounts+=(-v "$STAGENET_SECRET_FILE:/run/secrets/stagenet:ro")
  fi
  docker rm -f "$GATE" >/dev/null 2>&1 || true
  docker run --rm --name "$GATE" --init --network "$NETWORK" "${mounts[@]}" \
    -e PROOF_SERVER_URL="http://$PROVER:6300" -e GATE_EVIDENCE_DIR=/out -e GATE_STATE_DIR=/state \
    -w /app "$RUNNER_IMAGE" /opt/bun/bun test/gates/take/gate.ts "$@"
}

LOCK_NONCE=""
take_lock() {
  mkdir -p "$(dirname "$FUNDING_LOCK")"
  LOCK_NONCE="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
  local body deadline=$((SECONDS + LOCK_WAIT))
  body="$(printf '{"purpose":"AA 00048 G-TAKE fund (run-gate.sh)","pid":%d,"host":"%s","at":"%s","nonce":"%s"}' \
    "$$" "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LOCK_NONCE")"
  while :; do
    if (set -C && umask 077 && printf '%s' "$body" >"$FUNDING_LOCK") 2>/dev/null; then
      say "funding lock taken ($FUNDING_LOCK)"
      return 0
    fi
    local holder
    holder="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("purpose"), "since", d.get("at"))' "$FUNDING_LOCK" 2>/dev/null || echo unknown)"
    if ((SECONDS > deadline)); then
      say "the funding lock is still held by: $holder; giving up"
      return 1
    fi
    say "the funding lock is held by: $holder; waiting"
    sleep 20
  done
}
release_lock() {
  if [[ -n "$LOCK_NONCE" && -f "$FUNDING_LOCK" ]] && grep -q "\"nonce\":\"$LOCK_NONCE\"" "$FUNDING_LOCK"; then
    rm -f "$FUNDING_LOCK"
    say "funding lock released"
  fi
  LOCK_NONCE=""
}

cmd="${1:-}"
shift || true
case "$cmd" in
  up) up ;;
  derive | measure-sync | status)
    up
    sync_tree
    gate 0 "$cmd"
    ;;
  take)
    up
    sync_tree
    gate 0 take "$@"
    ;;
  fund)
    up
    sync_tree
    take_lock
    trap release_lock EXIT INT TERM
    gate 1 fund "$@"
    ;;
  down)
    docker rm -f "$GATE" "$PROVER" >/dev/null 2>&1 || true
    docker network rm "$NETWORK" >/dev/null 2>&1 || true
    docker volume rm "$PARAMS" >/dev/null 2>&1 || true
    rm -f "$PORT_FILE"
    say "removed $GATE, $PROVER, $NETWORK, $PARAMS"
    ;;
  *)
    echo "usage: $0 up | derive | fund <offerId> | take <offerId> | measure-sync | status | down" >&2
    exit 64
    ;;
esac

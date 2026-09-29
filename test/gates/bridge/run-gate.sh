#!/usr/bin/env bash
# run-gate.sh: run one step of the G-BRIDGE live gate (gate.ts) against Midnight stagenet and
# Sepolia, in Docker, with the owner's secrets mounted READ-ONLY and never on a command line.
#
#   test/gates/bridge/run-gate.sh preflight
#   test/gates/bridge/run-gate.sh derive [--token stkA]     # signs "start swap" with the Sepolia key
#   test/gates/bridge/run-gate.sh fund                      # Sepolia spend
#   test/gates/bridge/run-gate.sh deposit-start             # Midnight spend (the sponsor, locked)
#   test/gates/bridge/run-gate.sh relay --kind deposit      # no wallet: MPC signature, broadcast, attestation
#   test/gates/bridge/run-gate.sh deposit-complete          # Midnight spend (the sponsor, locked)
#   test/gates/bridge/run-gate.sh temp-check                # the temporary wallet's own sync
#   test/gates/bridge/run-gate.sh withdraw-build            # the temporary wallet proves (no lock)
#   test/gates/bridge/run-gate.sh withdraw-submit           # Midnight spend: the sponsor adds DUST (locked)
#   test/gates/bridge/run-gate.sh relay --kind withdraw
#   test/gates/bridge/run-gate.sh withdraw-complete         # Midnight spend (the sponsor, locked)
#   test/gates/bridge/run-gate.sh status
#
# Per step:
#   * the code runs from the docker-check volume (scripts/docker-check.sh: Node 24 + Bun 1.3.11,
#     node_modules in a named volume); the working tree is synced into it first;
#   * steps that PROVE start the pinned proof server (9.0.0-rc.6, by digest) on a random free
#     127.0.0.1 port >= 10000, after waiting for >= 8 GB of Docker memory headroom, and the gate
#     joins its network namespace;
#   * steps that open the sponsor wallet (`.stagenet`, shared) take the funding-wallet lock
#     (~/.stagenet-offer-ladders/funding.lock, the Offer Files protocol: one process per seed),
#     waiting up to 30 minutes, and hold it only while the step runs;
#   * steps that sign or send with the Sepolia user mount its key file read-only; sends wait while
#     another bridge driver runs (concurrent sends collide on the nonce);
#   * every container this script starts is removed on exit, and the lock is released.
#
# The vault's compiled module and keys are mounted from VAULT_MANAGED_DIR_HOST (default
# ~/.cache/aa-00048/vault-managed: Erc20Vault/ and SignetSigner/, as the vault's managed/ lays them
# out); `preflight` checks every verifier key against the chain.
#
# Environment (optional): STAGENET_WALLET_FILE_HOST, SEPOLIA_KEY_FILE_HOST, GATE_STATE_DIR_HOST,
# GATE_EVIDENCE_DIR_HOST, VAULT_MANAGED_DIR_HOST, DOCKER_CHECK_NAME, SEPOLIA_RPC_URL, FEE_BLOCKS_MARGIN.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CMD="${1:?usage: run-gate.sh <command> [--flags]}"
shift || true

WALLET_FILE="${STAGENET_WALLET_FILE_HOST:-/Users/edwardalvarado/todo/Offer Files/.stagenet}"
SEPOLIA_FILE="${SEPOLIA_KEY_FILE_HOST:-/Users/edwardalvarado/todo/Offer Files/.sepolia}"
STATE_HOST="${GATE_STATE_DIR_HOST:-$HOME/.config/aa-00048/gate-bridge}"
EVIDENCE_HOST="${GATE_EVIDENCE_DIR_HOST:-/Users/edwardalvarado/todo/AA/evidence/00048-evm-midnight-transparent/g-bridge}"
MANAGED_HOST="${VAULT_MANAGED_DIR_HOST:-$HOME/.cache/aa-00048/vault-managed}"
CHECK="${DOCKER_CHECK_NAME:-aa00048-gb-check}"
LOCK="$HOME/.stagenet-offer-ladders/funding.lock"
PROOF_IMAGE="midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b"
RUNNER_IMAGE="${RUNNER_IMAGE:-node:24-bookworm-slim}"
PREFIX="aa00048-gb"
TAG="$$"
PROOF_NAME="$PREFIX-proof-$TAG"
RUN_NAME="$PREFIX-run-$CMD-$TAG"

say() { printf '== %s\n' "$*" >&2; }

case "$CMD" in
  deposit-start|deposit-complete|withdraw-complete|withdraw-submit)
    NEEDS_PROOF=1; NEEDS_WALLET=1; NEEDS_SEPOLIA=0; SENDS_SEPOLIA=0 ;;
  withdraw-build) NEEDS_PROOF=1; NEEDS_WALLET=0; NEEDS_SEPOLIA=1; SENDS_SEPOLIA=0 ;;
  derive|temp-check) NEEDS_PROOF=0; NEEDS_WALLET=0; NEEDS_SEPOLIA=1; SENDS_SEPOLIA=0 ;;
  fund) NEEDS_PROOF=0; NEEDS_WALLET=0; NEEDS_SEPOLIA=1; SENDS_SEPOLIA=1 ;;
  preflight|relay|status) NEEDS_PROOF=0; NEEDS_WALLET=0; NEEDS_SEPOLIA=0; SENDS_SEPOLIA=0 ;;
  *) echo "unknown command $CMD" >&2; exit 2 ;;
esac

[ -d "$MANAGED_HOST/Erc20Vault/keys" ] && [ -d "$MANAGED_HOST/SignetSigner/keys" ] ||
  { echo "no vault artefacts at $MANAGED_HOST (Erc20Vault/, SignetSigner/)" >&2; exit 2; }
mkdir -p "$STATE_HOST" "$EVIDENCE_HOST"
chmod 700 "$STATE_HOST" "$(dirname "$STATE_HOST")"

cleanup() {
  docker rm -f "$RUN_NAME" >/dev/null 2>&1 || true
  docker rm -f "$PROOF_NAME" >/dev/null 2>&1 || true
  if [ "${LOCK_TAKEN:-0}" = 1 ]; then rm -f "$LOCK"; fi
}
trap cleanup EXIT INT TERM

# The code: the docker-check container's volume, synced with this working tree.
DOCKER_CHECK_NAME="$CHECK" bash "$REPO/scripts/docker-check.sh" up >/dev/null
DOCKER_CHECK_NAME="$CHECK" bash "$REPO/scripts/docker-check.sh" sync

wallet_in_use() {
  local ids
  ids="$(docker ps -q)"
  [ -n "$ids" ] && docker inspect --format '{{.Name}} {{range .Mounts}}{{.Source}} {{end}}' $ids 2>/dev/null |
    grep -F "/Offer Files/.stagenet" >/dev/null
}

if [ "$NEEDS_WALLET" = 1 ]; then
  [ -f "$WALLET_FILE" ] || { echo "no sponsor mnemonic file at the configured path" >&2; exit 2; }
  mkdir -p "$(dirname "$LOCK")"
  for i in $(seq 1 61); do
    if ! wallet_in_use && ( set -o noclobber
      printf '{"purpose":"aa-00048 g-bridge %s","pid":%s,"host":"%s","at":"%s"}' \
        "$CMD" "$$" "$(hostname)" "$(date -u +%FT%TZ)" > "$LOCK" ) 2>/dev/null; then
      LOCK_TAKEN=1; break
    fi
    [ "$i" = 61 ] && { echo "the funding wallet is still busy after 30 min: $(cat "$LOCK" 2>/dev/null)" >&2; exit 75; }
    say "the funding wallet is busy ($(cat "$LOCK" 2>/dev/null || echo 'a container has it mounted')); waiting 30 s ($i/60)"
    sleep 30
  done
  say "funding lock taken"
fi

if [ "$SENDS_SEPOLIA" = 1 ]; then
  for i in $(seq 1 16); do
    if ! ps -axo command | grep -E 'run-stagenet|deposit-fund|stagenet\.ts|gates/bridge/gate\.ts fund' | grep -v grep >/dev/null; then break; fi
    [ "$i" = 16 ] && { echo "another bridge driver is still sending from the funder after 30 min" >&2; exit 75; }
    say "another bridge driver is running; waiting 120 s before sending from the Sepolia user ($i/15)"
    sleep 120
  done
fi

NET_ARGS=()
if [ "$NEEDS_PROOF" = 1 ]; then
  for i in $(seq 1 31); do
    HEADROOM="$(docker stats --no-stream --format '{{.MemUsage}}' | python3 -c '
import re, sys
unit = {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "KB": 1e3, "MB": 1e6, "GB": 1e9}
used, total = 0.0, 0.0
for line in sys.stdin:
    a, b = [s.strip() for s in line.split("/")]
    m, n = re.match(r"([\d.]+)(\w+)", a), re.match(r"([\d.]+)(\w+)", b)
    used += float(m.group(1)) * unit[m.group(2)]
    total = max(total, float(n.group(1)) * unit[n.group(2)])
print(int((total - used) / 2**30) if total else 99)')"
    if [ "$HEADROOM" -ge 8 ]; then break; fi
    [ "$i" = 31 ] && { echo "Docker memory headroom stayed below 8 GB for 30 min" >&2; exit 75; }
    say "Docker memory headroom ${HEADROOM} GB < 8 GB (another proof?); waiting 60 s ($i/30)"
    sleep 60
  done
  PORT="$(python3 -c 'import random, socket
for _ in range(200):
    p = random.randint(10000, 60000); s = socket.socket()
    try: s.bind(("127.0.0.1", p)); s.close(); print(p); break
    except OSError: s.close()')"
  say "proof server $PROOF_NAME on 127.0.0.1:$PORT (headroom ${HEADROOM} GB)"
  docker run -d --name "$PROOF_NAME" -p "127.0.0.1:$PORT:6300" --memory 10g "$PROOF_IMAGE" >/dev/null
  for _ in $(seq 1 120); do curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null || { echo "the proof server did not become healthy" >&2; docker logs --tail 40 "$PROOF_NAME" >&2; exit 1; }
  say "proof server version $(curl -fsS "http://127.0.0.1:$PORT/version" || echo '?')"
  NET_ARGS=(--network "container:$PROOF_NAME")
fi

SECRET_ARGS=()
if [ "$NEEDS_WALLET" = 1 ]; then
  SECRET_ARGS+=(-v "$WALLET_FILE:/secrets/stagenet:ro" -e STAGENET_WALLET_FILE=/secrets/stagenet)
fi
if [ "$NEEDS_SEPOLIA" = 1 ]; then
  [ -f "$SEPOLIA_FILE" ] || { echo "no Sepolia key file at the configured path" >&2; exit 2; }
  SECRET_ARGS+=(-v "$SEPOLIA_FILE:/secrets/sepolia:ro" -e SEPOLIA_KEY_FILE=/secrets/sepolia)
fi

mkdir -p "$STATE_HOST/logs" && chmod 700 "$STATE_HOST/logs"
LOG="$STATE_HOST/logs/$CMD-$(date -u +%Y%m%dT%H%M%SZ).log"
say "log $LOG"
set +e
docker run --rm --name "$RUN_NAME" --init \
  ${NET_ARGS[@]+"${NET_ARGS[@]}"} \
  ${SECRET_ARGS[@]+"${SECRET_ARGS[@]}"} \
  -v "$CHECK-app:/app" -v "$CHECK-bun:/opt/bun:ro" \
  -v "$MANAGED_HOST:/app/.vault-managed:ro" \
  -v "$STATE_HOST:/state" -v "$EVIDENCE_HOST:/evidence" \
  -e PATH=/opt/bun:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -e GATE_STATE_DIR=/state -e GATE_EVIDENCE_DIR=/evidence -e VAULT_MANAGED_DIR=/app/.vault-managed \
  -e PROOF_SERVER_URL=http://127.0.0.1:6300 \
  -e FEE_BLOCKS_MARGIN="${FEE_BLOCKS_MARGIN:-5}" \
  ${SEPOLIA_RPC_URL:+-e SEPOLIA_RPC_URL="$SEPOLIA_RPC_URL"} \
  -w /app "$RUNNER_IMAGE" bun test/gates/bridge/gate.ts "$CMD" "$@" 2>&1 | tee "$LOG"
STATUS="${PIPESTATUS[0]}"
set -e
exit "$STATUS"

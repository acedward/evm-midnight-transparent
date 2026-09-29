#!/usr/bin/env bash
# L-WALLET's local proving check (not CI; see prove-check.ts). Needs the vault's compiled key
# directory (Erc20Vault/ and SignetSigner/ with keys/ and zkir/, as the vault's `managed/` lays them
# out; e.g. the sponsor's), mounted read-only.
#
#   VAULT_MANAGED_DIR_HOST=/path/to/managed EVIDENCE_DIR=/path/to/evidence bash packages/wallet/test/proving/run.sh
#
# It starts the pinned proof server on a private Docker network (no host port), runs the check in a
# container over the repository's check volume (scripts/docker-check.sh), and removes the proof
# server, its params volume and the network afterwards.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CHECK="${DOCKER_CHECK_NAME:-aa00048-lw-check}"
P="${PROVE_PREFIX:-aa00048-lw}"
NET="$P-net"
PROVER="$P-prover"
PARAMS="$P-params"
RUNNER_IMAGE="${RUNNER_IMAGE:-node:24-bookworm-slim}"
PROOF_IMAGE="midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819eacde273f725551fdf90ca7c31ebf3c0ff145f3ed58ee35f92fb7ce95b"
MANAGED="${VAULT_MANAGED_DIR_HOST:?set VAULT_MANAGED_DIR_HOST (the compiled vault keys)}"
EVIDENCE_DIR="${EVIDENCE_DIR:?set EVIDENCE_DIR}"

cleanup() {
  docker rm -f "$PROVER" "$P-prove-$$" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$PARAMS" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

mkdir -p "$EVIDENCE_DIR"
DOCKER_CHECK_NAME="$CHECK" "$ROOT/scripts/docker-check.sh" up >/dev/null
DOCKER_CHECK_NAME="$CHECK" "$ROOT/scripts/docker-check.sh" sync
docker network create "$NET" >/dev/null
docker volume create "$PARAMS" >/dev/null
# The params directory is the proof server's own writable volume: it fetches the public parameters
# and the zswap/DUST keys there at start (as the G-TAKE gate runs it).
docker run -d --name "$PROVER" --network "$NET" --memory 8g --cap-drop ALL --security-opt no-new-privileges:true \
  -e PORT=6300 -e MIDNIGHT_PP=/proof-params -v "$PARAMS:/proof-params" "$PROOF_IMAGE" >/dev/null
ready=0
for _ in $(seq 1 120); do
  if docker run --rm --network "$NET" "$RUNNER_IMAGE" node -e "fetch('http://$PROVER:6300/version').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; then
    ready=1
    break
  fi
  sleep 3
done
if [[ "$ready" != 1 ]]; then
  echo "the proof server did not answer /version" >&2
  docker logs --tail 30 "$PROVER" >&2
  exit 1
fi
docker run --rm --name "$P-prove-$$" --init --network "$NET" --memory 4g \
  -v "$CHECK-app:/app" -v "$CHECK-bun:/opt/bun:ro" -v "$MANAGED:/managed:ro" -v "$EVIDENCE_DIR:/out" \
  -e PROOF_SERVER_URL="http://$PROVER:6300" -e VAULT_MANAGED_DIR=/managed -e EVIDENCE_DIR=/out \
  -w /app "$RUNNER_IMAGE" /opt/bun/bun packages/wallet/test/proving/prove-check.ts

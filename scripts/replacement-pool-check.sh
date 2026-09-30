#!/usr/bin/env bash
# R2 against a REAL transaction pool (plan 00048 P4.2-fix2; audit R2): a geth dev node in Docker,
# the replacement test (sponsor/test/replacement-pool.test.ts) run in the check runner of
# scripts/docker-check.sh, then everything removed. Nothing is published on a host port: the runner
# reaches the node over a private Docker network. The node's miner takes no tip under 1.1 gwei (see
# the test's header: that is what keeps a 1 gwei-tip transfer pending on a dev node).
#
#   DOCKER_CHECK_NAME=emt-check scripts/docker-check.sh up && scripts/docker-check.sh sync   (first)
#   DOCKER_CHECK_NAME=emt-check scripts/replacement-pool-check.sh
#
# Environment: DOCKER_CHECK_NAME (the runner's prefix, as for docker-check.sh), GETH_IMAGE (default: geth 1.17.6-stable by digest, the
# ethereum/client-go:stable of 2026-09-30), POOL_CHECK_NAME (the node's and network's prefix; default
# <DOCKER_CHECK_NAME>-pool).
set -euo pipefail

CHECK="${DOCKER_CHECK_NAME:-emt-check}"
RUNNER="$CHECK-runner"
NAME="${POOL_CHECK_NAME:-$CHECK-pool}"
IMAGE="${GETH_IMAGE:-ethereum/client-go@sha256:de3e76f7a16290e650da3c15cf55fa569cda185d2014fd8f057377e0ce825e62}" # geth 1.17.6-stable
NET="$NAME-net"
NODE="$NAME-geth"

cleanup() {
  docker network disconnect "$NET" "$RUNNER" >/dev/null 2>&1 || true
  docker rm -f "$NODE" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

[[ "$(docker inspect -f '{{.State.Running}}' "$RUNNER" 2>/dev/null)" == true ]] || {
  echo "the check runner $RUNNER is not running: scripts/docker-check.sh up && sync first" >&2
  exit 64
}
cleanup
docker network create "$NET" >/dev/null
docker run -d --name "$NODE" --network "$NET" "$IMAGE" \
  --dev --dev.period 0 --miner.gasprice 1100000000 --http --http.addr 0.0.0.0 --http.port 8545 \
  --http.api eth,net,web3,txpool --http.vhosts '*' --verbosity 2 >/dev/null
docker network connect "$NET" "$RUNNER"
echo "geth: $(docker exec "$NODE" geth version 2>/dev/null | grep -m1 '^Version' || echo unknown) ($IMAGE)"

rpc="http://$NODE:8545"
for _ in $(seq 1 60); do
  if docker exec "$RUNNER" node -e "fetch('$rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})}).then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 1
done

docker exec -w /app -e "EVM_DEV_RPC_URL=$rpc" "$RUNNER" bash -lc 'npx vitest run sponsor/test/replacement-pool.test.ts'

#!/usr/bin/env bash
# The web bundle's default Content-Security-Policy in a real browser (plan 00048 P4.2-fix, audit C15).
#
#   bash deploy/web/csp-browser-check.sh
#
# Builds the web image, runs it with its DEFAULT policy (no WEB_CONTENT_SECURITY_POLICY), and runs, in
# the Playwright image and the web container's network namespace, ./csp-check/csp.spec.ts (the header;
# live mode: the stagenet book read and the wallet chunk's WASM compiled; mock mode) and the
# repository's browser specs (test/e2e, mock mode), all against that container. Read-only against
# stagenet (the exchange's public book); no transaction. Everything is named aa00048-csp-* (override
# with CSP_CHECK_NAME) and removed at the end. Needs Docker and the repository's node_modules in the
# docker-check volume (DOCKER_CHECK_NAME, default emt-check: `scripts/docker-check.sh up sync install`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NAME="${CSP_CHECK_NAME:-aa00048-csp}"
APP_VOLUME="${DOCKER_CHECK_NAME:-emt-check}-app"
PW_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.0-noble}"
IMAGE="evm-midnight-transparent/web:$NAME"
NET="$NAME-net"
WEB="$NAME-web"

cleanup() {
  docker rm -f "$WEB" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  if [[ "${KEEP_IMAGE:-0}" != 1 ]]; then docker image rm "$IMAGE" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

docker build -q -f "$ROOT/deploy/web.Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null
docker network create "$NET" >/dev/null
docker run -d --name "$WEB" --network "$NET" --read-only --tmpfs /tmp --cap-drop ALL \
  --security-opt no-new-privileges "$IMAGE" >/dev/null
for _ in $(seq 1 30); do
  docker exec "$WEB" wget -q -O /dev/null http://127.0.0.1:8080/healthz 2>/dev/null && break
  sleep 1
done
echo "csp-check: the policy the image serves:"
docker exec "$WEB" wget -q -S -O /dev/null http://127.0.0.1:8080/ 2>&1 | grep -i 'content-security-policy' || {
  echo "csp-check: NO Content-Security-Policy header" >&2
  exit 1
}
docker run --rm --network "container:$WEB" -v "$APP_VOLUME:/app" -w /app -e CI=1 "$PW_IMAGE" \
  npx playwright test -c deploy/web/csp-check/playwright.config.ts
echo "csp-check: PASS"

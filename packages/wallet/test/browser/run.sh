#!/usr/bin/env bash
# L-WALLET's headless-browser check (plan 00048, L-WALLET): the wallet module in Chromium against
# stagenet, READ-ONLY (nothing is proven or submitted; no secret files are read).
#
#   EVIDENCE_DIR=/path/to/evidence bash packages/wallet/test/browser/run.sh
#
# 1. In the repository's Docker check container (scripts/docker-check.sh, DOCKER_CHECK_NAME, default
#    aa00048-lw-check): sync the tree, build the page with Vite (no plugins) and bundle the driver for
#    Node with Bun.
# 2. In the Playwright image (Chromium), on Docker's default network: run the driver over the same
#    volume. It writes $EVIDENCE_DIR/browser.json and exits non-zero on any failed check.
# The containers are removed when they stop; `scripts/docker-check.sh down` removes the check volume.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CHECK="${DOCKER_CHECK_NAME:-aa00048-lw-check}"
PLAYWRIGHT_IMAGE="${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.62.0-noble}"
BROWSER="${BROWSER_CONTAINER:-aa00048-lw-browser-$$}"
EVIDENCE_DIR="${EVIDENCE_DIR:?set EVIDENCE_DIR (a folder for the public evidence)}"

mkdir -p "$EVIDENCE_DIR"
DOCKER_CHECK_NAME="$CHECK" "$ROOT/scripts/docker-check.sh" up >/dev/null
DOCKER_CHECK_NAME="$CHECK" "$ROOT/scripts/docker-check.sh" sync
DOCKER_CHECK_NAME="$CHECK" "$ROOT/scripts/docker-check.sh" run \
  'bun install --frozen-lockfile >/dev/null &&
   npx vite build --config packages/wallet/test/browser/vite.config.ts --logLevel warn &&
   bun build ./packages/wallet/test/browser/run.ts --target=node --external playwright-core --outfile test-results/wallet-browser-run.mjs >/dev/null &&
   ls -la test-results/wallet-browser/assets | awk "{print \$5, \$9}"'
docker rm -f "$BROWSER" >/dev/null 2>&1 || true
docker run --rm --name "$BROWSER" --init --memory 4g \
  -v "$CHECK-app:/app" -v "$EVIDENCE_DIR:/out" \
  -e EVIDENCE_DIR=/out -w /app "$PLAYWRIGHT_IMAGE" node test-results/wallet-browser-run.mjs

# syntax=docker/dockerfile:1
# The sponsor. The image holds code only: no keys, no seed, no data. At run time:
#   - the vault key directory (deploy/vault-keys/, verified against the chain) is mounted READ-ONLY
#     at /app/vault-managed, where the compiled vault module resolves this image's node_modules;
#   - the swaps are kept in /data (a volume; public values only, see sponsor/src/swaps/store.ts);
#   - the secrets are files: SPONSOR_SEED_FILE and SEPOLIA_RPC_URL_FILE (sponsor/README.md).
# Build from the repository root:
#   docker build -f deploy/sponsor.Dockerfile -t evm-midnight-transparent/sponsor .

ARG BUN_IMAGE=oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY packages/wallet/package.json packages/wallet/
COPY sponsor/package.json sponsor/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM ${BUN_IMAGE}
WORKDIR /app
ENV NODE_ENV=production \
    SPONSOR_HOST=0.0.0.0 \
    SPONSOR_PORT=8080 \
    SPONSOR_DATA_DIR=/data \
    VAULT_MANAGED_DIR=/app/vault-managed
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY sponsor/package.json sponsor/
COPY sponsor/src sponsor/src
RUN mkdir -p /data /app/vault-managed && chown bun:bun /data
VOLUME ["/data"]
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD bun -e "fetch('http://127.0.0.1:' + (process.env.SPONSOR_PORT || 8080) + '/v1/config').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "sponsor/src/main.ts"]

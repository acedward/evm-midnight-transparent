# syntax=docker/dockerfile:1
# The vault key job (deploy/vault-keys/build.sh): compactc 0.34.0, the vault's pinned sources and the
# sponsor's dependencies (for the Signet Compact module and the chain check). It builds the key
# directory the sponsor mounts at /app/vault-managed; the image itself carries no keys.
# Build from the repository root:
#   docker build -f deploy/vault-keys.Dockerfile -t evm-midnight-transparent/vault-keys .
# Run (compile; or `import` with a directory mounted at /import; or `verify`):
#   docker run --rm -v <keys-volume>:/app/vault-managed evm-midnight-transparent/vault-keys

ARG BUN_IMAGE=oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7

# The sponsor's production dependencies (the same lines as deploy/sponsor.Dockerfile: a shared layer).
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY packages/wallet/package.json packages/wallet/
COPY sponsor/package.json sponsor/
COPY web/package.json web/
RUN bun install --frozen-lockfile --production --ignore-scripts

# compactc 0.34.0 from its release archive, checked against the SHA-256 pinned in the script.
FROM ${BUN_IMAGE} AS compactc
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl unzip \
 && rm -rf /var/lib/apt/lists/*
COPY scripts/fetch-compactc.sh /tmp/fetch-compactc.sh
RUN COMPACTC_DIR=/opt/compactc bash /tmp/fetch-compactc.sh

# The vault's Compact sources at the pinned commit (the repository is public; git checks the commit).
FROM ${BUN_IMAGE} AS sources
ARG VAULT_SOURCE_REPO=https://github.com/acedward/passport.git
ARG VAULT_SOURCE_COMMIT=6c7505a4d2ec223fce5eb10266c331576805465a
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
RUN git init -q /tmp/repo \
 && git -C /tmp/repo fetch -q --depth 1 "${VAULT_SOURCE_REPO}" "${VAULT_SOURCE_COMMIT}" \
 && git -C /tmp/repo checkout -q FETCH_HEAD \
 && test "$(git -C /tmp/repo rev-parse HEAD)" = "${VAULT_SOURCE_COMMIT}" \
 && mkdir -p /src/vault/vendor \
 && cp /tmp/repo/contract/contracts/erc20-vault/src/erc20-vault.compact /src/vault/ \
 && cp /tmp/repo/contract/contracts/erc20-vault/src/vendor/*.compact /src/vault/vendor/

FROM ${BUN_IMAGE}
ARG VAULT_SOURCE_COMMIT=6c7505a4d2ec223fce5eb10266c331576805465a
ENV NODE_ENV=production \
    HOME=/tmp \
    VAULT_SOURCE_COMMIT=${VAULT_SOURCE_COMMIT}
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=compactc /opt/compactc /opt/compactc
# zkir fetches the proving system's public parameters over HTTPS and needs the CA bundle.
COPY --from=compactc /etc/ssl/certs /etc/ssl/certs
COPY --from=sources /src/vault /src/vault
COPY package.json bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY sponsor/package.json sponsor/
COPY sponsor/src sponsor/src
COPY deploy/vault-keys/build.sh /usr/local/bin/vault-keys
RUN chmod 0755 /usr/local/bin/vault-keys \
 && mkdir -p /app/vault-managed /import \
 && chown bun:bun /app/vault-managed
USER bun
ENTRYPOINT ["/usr/local/bin/vault-keys"]

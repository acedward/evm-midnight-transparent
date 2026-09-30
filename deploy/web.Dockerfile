# syntax=docker/dockerfile:1
# The web app: the static site, built here and served by an unprivileged nginx, which also proxies
# /sponsor/ to the sponsor so the site and its sponsor share one origin (no CORS). The site's runtime
# configuration (/config.json) is written at start from the environment (deploy/web/entrypoint.sh),
# so one image serves any network. No secret is ever in this image. The in-browser Midnight wallet
# (packages/wallet, with the ledger and runtime WASM) is part of the build, as a chunk the page
# loads on first use. Adapted from MN Bank (acedward/passport-evm-dapp @ 911647b, deploy/web.Dockerfile).
# Build from the repository root:
#   docker build -f deploy/web.Dockerfile -t evm-midnight-transparent/web .

ARG BUN_IMAGE=oven/bun:1.3.11@sha256:0733e50325078969732ebe3b15ce4c4be5082f18c4ac1a0f0ca4839c2e4e42a7
ARG NGINX_IMAGE=nginx:1.31.5-alpine@sha256:72ba65eb42c10344912a84ff42408db7d34f2feb642204570ab8fc5ffd29f1d3

FROM ${BUN_IMAGE} AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/core/package.json packages/core/
COPY packages/wallet/package.json packages/wallet/
COPY sponsor/package.json sponsor/
COPY web/package.json web/
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY packages/wallet packages/wallet
COPY web web
RUN bun run build:web \
 && rm -f web/dist/config.json \
 && find web/dist -name '*.map' -delete

FROM ${NGINX_IMAGE}
COPY deploy/web/nginx.conf /etc/nginx/nginx.conf
COPY deploy/web/entrypoint.sh /usr/local/bin/emt-web
COPY --from=build /app/web/dist /usr/share/nginx/html
RUN chmod 0755 /usr/local/bin/emt-web \
 && rm -rf /etc/nginx/conf.d /docker-entrypoint.d
USER nginx
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/emt-web"]

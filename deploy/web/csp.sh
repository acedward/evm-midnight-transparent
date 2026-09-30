#!/bin/sh
# The web site's DEFAULT Content-Security-Policy (plan 00048 P4.2-fix, audit C15 / F-A12).
#
# The page holds the temporary Midnight wallet's keys in memory and drives the user's signature
# prompts and funding transfers, so a strict policy is its main containment against an injected
# script or a compromised dependency. What the site needs, and nothing else:
#   script-src  'self' + 'wasm-unsafe-eval'  the bundle, and the ledger / runtime WASM it compiles
#   style-src   'self'                       the built CSS (React sets styles through the CSSOM)
#   font-src    'self'                       the fonts are self-hosted (web/src/design/fonts.ts)
#   img-src     'self' data:
#   connect-src 'self' (config.json, the WASM, the /sponsor proxy) + the network's exchange kernel
#               and batcher, its Midnight indexer (https and wss) and node (https and wss), and the
#               sponsor's origin when WEB_SPONSOR_URL is absolute, and WEB_CSP_CONNECT_EXTRA
#   worker-src  'self' blob:
#   object-src 'none', base-uri 'none', frame-ancestors 'none', form-action 'none'
# The stagenet origins here are core's STAGENET profile (packages/core/src/network.ts); a test
# (packages/core/test/deploy-csp.test.ts) runs this script and checks them against the profile.
#
# Sourced by ./entrypoint.sh; also runnable: sh deploy/web/csp.sh <network> <sponsor url> [extra origins]

emt_default_csp() {
  _network="$1"
  _sponsor="$2"
  _extra="${3:-}"
  case "$_network" in
    stagenet)
      _connect="https://stagenet.api-zswap.zkdojo.com https://stagenet.batcher-zswap.zkdojo.com"
      _connect="$_connect https://indexer.stagenet.shielded.tools wss://indexer.stagenet.shielded.tools"
      _connect="$_connect https://rpc.stagenet.shielded.tools wss://rpc.stagenet.shielded.tools"
      ;;
    undeployed)
      # A local stack: its services by their Docker names, and anything on this machine.
      _connect="http://kernel:9999 http://batcher:3334 http://indexer:8088 ws://indexer:8088 http://node:9944"
      _connect="$_connect ws://node:9944 http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*"
      ;;
    *)
      echo "emt-web: no default Content-Security-Policy for network '$_network'" >&2
      return 1
      ;;
  esac
  case "$_sponsor" in
    https://* | http://*) _connect="$_connect $(echo "$_sponsor" | sed -E 's#^(https?://[^/?#]+).*$#\1#')" ;;
  esac
  for _origin in $(echo "$_extra" | tr ',' ' '); do
    echo "$_origin" | grep -Eq '^(https|wss)://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' || {
      echo "emt-web: WEB_CSP_CONNECT_EXTRA: '$_origin' is not an https:// or wss:// origin" >&2
      return 1
    }
    _connect="$_connect $_origin"
  done
  printf "%s" "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' $_connect; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
}

case "${0##*/}" in
  csp.sh) emt_default_csp "$@" ;;
esac

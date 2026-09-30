#!/usr/bin/env bash
# The sponsor's vault key directory: the ERC20 vault and its callee, the Signet singleton, compiled
# WITH prover and verifier keys by compactc 0.34.0 from the pinned vault sources, then verified
# against the chain (every bridge circuit's verifier key, and the singleton's signBidirectional,
# must equal the deployed one: the G-BRIDGE preflight). The sponsor loads this directory
# (VAULT_MANAGED_DIR) to call the vault and to prove the swaps' startWithdraw; its proof server gets
# the keys from the sponsor with each proof, so only the sponsor mounts it.
#
# Runs inside the image deploy/vault-keys.Dockerfile builds (compactc, the sources and the
# sponsor's dependencies are pinned there). The output is the mounted directory $OUT (default
# /app/vault-managed), laid out as the vault's own managed/:
#   $OUT/Erc20Vault/{contract,compiler,zkir,keys}   $OUT/SignetSigner/{...}   $OUT/.vault-keys.json
#
# Modes:
#   build.sh            compile (about 10-20 minutes, a few GB of memory), verify, install
#   build.sh import     take a directory built elsewhere, mounted read-only at $IMPORT_DIR
#                       (for example ~/.cache/aa-00048/vault-managed, the G-BRIDGE gate's), and
#                       put it through exactly the same verification before installing it
#   build.sh verify     only re-verify what $OUT holds (a few seconds)
#   build.sh ensure     the Compose job (deploy/compose.yml): verify what $OUT holds if it is
#                       installed; otherwise import (when $IMPORT_DIR holds a directory) or compile
# Any failure exits non-zero and installs nothing.
set -euo pipefail
umask 022

APP=/app
OUT="${OUT:-$APP/vault-managed}"
SRC=/src/vault
NM="$APP/node_modules"
CC=/opt/compactc/compactc
TOOL=(bun "$APP/sponsor/src/tools/vault-keys.ts")
IMPORT_DIR="${IMPORT_DIR:-/import}"
export MIDNIGHT_PP="${MIDNIGHT_PP:-/tmp/zk-params}"

# The pinned sources (acedward/passport @ VAULT_SOURCE_COMMIT, contract/contracts/erc20-vault/src).
VAULT_SHA256=d68c2e0213bbf8ab0db17835dabad6ce131f6eb53135479f2eb6336e567f19c9
SIGNET_SHA256=004c8acdef1bd689480ecb544830262076d180739591be65f822eed480cad808
TOKEN_METADATA_SHA256=1f1f9424f2dda6e60d6755389a6fa2822250a9a42ac3e5a391526393f82ca078

say() { printf 'vault-keys: %s\n' "$*" >&2; }
die() {
  say "FAILED: $*"
  exit 1
}
trap 'say "stopped by a signal"; exit 143' TERM INT

mode="${1:-compile}"
[[ -d "$OUT" && -w "$OUT" ]] || die "the output directory $OUT is missing or not writable by uid $(id -u)"
mkdir -p "$MIDNIGHT_PP" 2>/dev/null || true

if [[ "$mode" == ensure ]]; then
  if [[ -f "$OUT/.vault-keys.json" && -d "$OUT/Erc20Vault" && -d "$OUT/SignetSigner" ]]; then
    mode=verify
  elif [[ -f "$IMPORT_DIR/Erc20Vault/contract/index.js" ]]; then
    mode=import
  else
    mode=compile
  fi
  say "ensure: $mode"
fi

if [[ "$mode" == verify ]]; then
  "${TOOL[@]}" verify "$OUT" >/dev/null || die "$OUT does not verify against the chain"
  say "OK: $OUT verified"
  exit 0
fi

W="$OUT/.work"
rm -rf "$W"
mkdir -p "$W"
ok=0
cleanup() { if [[ "$ok" != 1 ]]; then rm -rf "$W"; fi; }
trap cleanup EXIT

started=$SECONDS
case "$mode" in
  compile)
    [[ "$("$CC" --version)" == 0.34.0 ]] || die "compactc 0.34.0 required, found $("$CC" --version)"
    sig="$(bun -e "console.log(require('$NM/@sig-net/midnight/package.json').version)")"
    [[ "$sig" == 0.23.0 ]] || die "@sig-net/midnight 0.23.0 required, found $sig"
    check() { [[ "$(sha256sum "$1" | cut -d' ' -f1)" == "$2" ]] || die "$1 is not the pinned source ($2)"; }
    check "$SRC/erc20-vault.compact" "$VAULT_SHA256"
    check "$SRC/vendor/signet-contract.compact" "$SIGNET_SHA256"
    check "$SRC/vendor/TokenMetadata.compact" "$TOKEN_METADATA_SHA256"
    say "sources pinned (vault $VAULT_SHA256, commit ${VAULT_SOURCE_COMMIT:-unknown}); compactc $("$CC" --version) (archive $(cat /opt/compactc/.archive-sha256 2>/dev/null || echo '?'))"
    compile() { # <label> <compact-path> <source> <target>
      local t0=$SECONDS
      say "compiling $1"
      COMPACT_PATH="$2" "$CC" --feature-zkir-v3 --compact-path "$2" "$3" "$4"
      say "$1 done in $((SECONDS - t0)) s"
    }
    # The callee first: the compiler resolves the declared contract type SignetSigner to
    # <compact-path>/SignetSigner, and the vault's generated JavaScript imports it by relative path.
    compile SignetSigner "$NM" "$SRC/vendor/signet-contract.compact" "$W/SignetSigner"
    compile Erc20Vault "$NM:$W" "$SRC/erc20-vault.compact" "$W/Erc20Vault"
    ;;
  import)
    for b in Erc20Vault SignetSigner; do
      [[ -f "$IMPORT_DIR/$b/contract/index.js" ]] || die "$IMPORT_DIR has no $b bundle"
      say "importing $b from $IMPORT_DIR"
      cp -RL "$IMPORT_DIR/$b" "$W/$b"
    done
    ;;
  *) die "unknown mode $mode (compile, import, verify or ensure)" ;;
esac
say "$mode took $((SECONDS - started)) s ($(du -sh "$W" | cut -f1))"

"${TOOL[@]}" verify "$W" >/dev/null || die "the $mode result does not verify against the chain (run verify for the report)"

for b in Erc20Vault SignetSigner; do
  rm -rf "${OUT:?}/$b"
  mv "$W/$b" "$OUT/$b"
done
mv "$W/.vault-keys.json" "$OUT/.vault-keys.json"
rm -rf "$W"
ok=1
say "OK: $OUT installed and verified ($mode, $((SECONDS - started)) s, $(du -sh "$OUT" | cut -f1))"

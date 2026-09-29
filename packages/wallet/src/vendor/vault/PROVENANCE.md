# The vault's compiled contract JS (vendored, browser-safe, no keys)

The temporary wallet builds the vault's `startWithdraw` in the browser (`../../withdraw.ts`). midnight-js
runs the circuit's JavaScript against the vault's live state to produce the unproven call; the proof is
made by the sponsor, which holds the prover keys. So the browser needs the generated contract module and
nothing else: **no prover keys, no verifier keys, no zkir** (the source maps ride along).

| File | sha256 |
|---|---|
| `Erc20Vault/contract/index.js` | `d98e12adb189430b1cc28ff3a6007d7007a7e3c86e718ac92cba51dab4359296` |
| `Erc20Vault/contract/index.d.ts` | `66081e5080c60d9d1fefe33f92b5e032b5b745196b7e14cae26e242a059b8021` |
| `SignetSigner/contract/index.js` | `61464470a693cda984e77062536450ccc5e9221ea5be68281a2784f75b5f6a95` |
| `SignetSigner/contract/index.d.ts` | `25c8e81566785af7a2c1f399fda9b8c4dba1de0c2f4e23b0cb8b9ad87183c36f` |
| `Erc20Vault/contract/index.js.map` | `d503e23c5477f89684b04b5241062d0fa5576c88a8f1caf670217f385487465c` |
| `SignetSigner/contract/index.js.map` | `d8849451e290129d164895f5509cf6df12844a9371b8694db05844fad95c86bc` |

`../../../test/vendor-vault.test.ts` re-checks these hashes, the compiler and runtime versions, and every
circuit's verifier-key fingerprint (`expectedVk`) against the stagenet vault as deployed.

## Source

- **Contract**: `acedward/passport` PR #4 @ `6c7505a4d2ec223fce5eb10266c331576805465a`,
  `contract/contracts/erc20-vault/src/erc20-vault.compact` (sha256 `d68c2e02…f19c9`), with its vendored
  `src/vendor/signet-contract.compact` (`004c8acd…ad808`) and `src/vendor/TokenMetadata.compact`
  (`1f1f9424…ca078`, MIP-0018), and `@sig-net/midnight` 0.23.0 `src/Signet.compact` (`24e2cc58…db692`)
  from this repository's install (the vault's own `package-lock.json` pins the same integrity).
- **Compiler**: `compactc` 0.34.0 (language 0.26.0, runtime 0.19.0), the official LFDT release
  `compactc_v0.34.0_aarch64-unknown-linux-musl.zip` (sha256 `d3e292c4f48e257dcd6b3d3e3e4743d7d8ea0729f48953eab91a366d44cd026d`),
  in a throwaway Docker container.
- **Commands**: the vault package's own `compile:signet` and `compile:vault` scripts, callee first (the vault's
  generated module imports `../../SignetSigner/contract/index.js`, so the two directories stay side by side):

  ```sh
  COMPACT_PATH=node_modules compactc --feature-zkir-v3 --compact-path node_modules \
    src/vendor/signet-contract.compact managed/SignetSigner
  COMPACT_PATH=node_modules compactc --feature-zkir-v3 --compact-path node_modules:managed \
    src/erc20-vault.compact managed/Erc20Vault
  ```

  A FULL compile (with keys), because the generated module records each circuit's verifier-key
  fingerprint as `expectedVk`, and compact-runtime 0.19.0 refuses a cross-contract call unless the
  callee module's `expectedVk` equals the sha256 of the verifier key deployed on chain: `startWithdraw`
  calls the Signet singleton's `signBidirectional`, so `SignetSigner`'s `expectedVk` must be real. Only
  `contract/index.js`, `contract/index.d.ts` and the source map the JS names are kept; the keys and
  zkir stay with the sponsor.

## Checks made when vendoring (2026-09-29, L-WALLET)

- Every verifier key of this compile equals the chain's: the 7 original vault circuits equal
  `deployments/stagenet-vault-vk-baseline.json` (the vault as deployed) and the G-BRIDGE preflight, and
  `SignetSigner`'s `respond`, `respondBidirectional` and `signBidirectional` equal the singleton's.
  `publishTokenMetadata` (`d75c5f4e…2b27`) is the circuit project 00038 added by a maintenance update;
  it equals the chain's too (the vault state recorded at block 679,357, `test/fixtures/`).
- Built offline on that recorded state with G-BRIDGE B.3.1's arguments, this module's `startWithdraw`
  creates the gate's live request `21d8b43d…2900` (vault request nonce 27), byte for byte the same id.
- The zkir of every original circuit is byte-identical to the compile the G-BRIDGE gate used live
  (passport `51c1fb4`, cached at `~/.cache/aa-00048/vault-managed`); the generated JS differs only by the
  added MIP-0018 circuit (and the descriptor numbering it shifts) and, for `SignetSigner`, by the line
  numbers of the vendored source's header in error messages.
- The trailing `//# sourceMappingURL=index.js.map` line is kept byte for byte, with its map (Vite and
  Vitest look for it).

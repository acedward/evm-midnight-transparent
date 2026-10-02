# G-BRIDGE: the vault round trip for a swap's temporary wallet

A live, script-level gate (plan 00048, P1). A swap's **temporary Midnight wallet** (derived from the
user's EIP-712 "start swap" signature) receives exactly 1 token through the ERC20 vault and sends it
back to the user's Sepolia address. The temporary wallet never holds DUST: the **sponsor** pays every
bridge leg. Nothing here runs in CI except the unit tests of the reusable parts in `sponsor/src/bridge`.

The two mechanisms it proves:

1. **A third-party `completeDeposit`** (B.2): the sponsor settles a deposit whose recipient is the
   temporary wallet, sealing the minted coin to the temporary wallet's encryption key with
   midnight-js `submitCallTx(..., { additionalCoinEncPublicKeyMappings })`; the temporary wallet's own
   sync then sees and spends the coin.
2. **The split DUST balancing of `startWithdraw`** (B.3): the temporary wallet builds the call, balances
   ONLY its shielded side (`ShieldedWallet.balanceTransaction`), proves and binds it; the sponsor adds
   DUST with `balanceFinalizedTransaction(tx, sponsorKeys, { tokenKindsToBalance: ['dust'] })`, merges it
   (`finalizeRecipe`) and submits.

| File | What it is |
|---|---|
| `gate.ts` | The live driver: one command per step, state outside the repository, resumable by request id. |
| `temp-wallet.ts` | The temporary wallet as the gate drives it: T.1's derivation (`deriveSwapSeed`, `temporaryWalletKeys`), the shielded-only wallet (`openShieldedWallet`), and its `startWithdraw` builder (L-WALLET moves it into `packages/wallet`). |
| `run-gate.sh` | The Docker wrapper: the code from the `docker-check.sh` volume, the pinned proof server, the shared funding-wallet lock, read-only secret mounts. |
| `../../../sponsor/src/bridge/` | The reusable parts: `vault.ts` (the vault runtime, the sponsor's legs, the DUST top-up), `vendor/relayer.ts` (the vault's relayer, verbatim) and `vendor/signet-sdk.ts`. The deposit address computed offline is `packages/core/src/deposit-address.ts` (moved there by L-WALLET). |

## Inputs

| What | Pin |
|---|---|
| The vault | `acedward/passport` PR #4 @ `6c7505a`, stagenet `7771c9e5…d637`, EVM account `0x6482…8FaA` (`packages/core/src/tokens/deployments/stagenet-vault.json`) |
| Compiled vault and keys | NOT in the repository: `VAULT_MANAGED_DIR_HOST` (default `~/.cache/aa-00048/vault-managed`) holds `Erc20Vault/` and `SignetSigner/` as the vault's `managed/` lays them out (compactc 0.34.0, `--feature-zkir-v3`). `preflight` checks every bridge circuit's verifier key, and the singleton's `signBidirectional`, against the chain. |
| SDK set | midnight-js 5.0.0-beta.7, ledger-v9 1.0.0-rc.3, wallet-sdk-facade 5.0.0-beta.2, compact-runtime 0.19.0, `@sig-net/midnight` 0.23.0 (integrity equal to the vault's `package-lock.json`) |
| Proof server | `midnightntwrk/proof-server:9.0.0-rc.6@sha256:38a819ea…` |
| Network | stagenet node `2.0.0-d9729c13` (`preflight` checks it) and Sepolia |

## Running it

```sh
export DOCKER_CHECK_NAME=aa00048-gb-check        # the node_modules volume (scripts/docker-check.sh)
bash scripts/docker-check.sh up && bash scripts/docker-check.sh sync && bash scripts/docker-check.sh install
G=test/gates/bridge/run-gate.sh
$G preflight
$G derive --token stkA        # B.1: new salt, sign twice, the deposit address three ways
$G fund                       # B.2.1: exactly 1 token + the sized sweep ETH
$G deposit-start              # B.2.2: the sponsor (locked)
$G relay --kind deposit       # B.2.3: about 15-20 min; no lock
$G deposit-complete           # B.2.4: the sponsor (locked), with the encryption-key mapping
$G temp-check                 # B.2.5: the temporary wallet's own sync sees the coin
$G withdraw-build             # B.3.1: the temporary wallet builds, balances shielded only, proves
$G withdraw-submit            # B.3.2: the sponsor adds DUST and submits (locked)
$G relay --kind withdraw      # B.3.3: the MPC transfer to the user
$G withdraw-complete          # B.3.4: the sponsor (locked)
$G temp-check --final        # after: the temporary wallet holds nothing
$G summary                    # B.4: timings, DUST per leg, gas, stranded ETH (from the state)
$G status
```

The state (`GATE_STATE_DIR_HOST`, default `~/.config/aa-00048/gate-bridge`, mode 700) holds public
values only: the salt, public keys, addresses, request ids and transaction hashes, plus the proven
`startWithdraw` between the build and the submit. The temporary wallet's key is re-derived from a new
signature in each step that needs it and never leaves the process. Evidence goes to
`GATE_EVIDENCE_DIR_HOST`.

**Sweep sizing** (spec Q5 A): `maxPriorityFeePerGas` = 0.5 gwei, `maxFeePerGas` = `ceil_0.1gwei(2 ×
latest baseFee + tip)`, `gasLimit` = 65,000 (a stk sweep uses 46,777 gas); the sweep ETH sent is
exactly `gasLimit × maxFeePerGas`, the balance the node requires of the sender.

**Stop rules** (plan G-BRIDGE): a refusal is a STOP (record the error and a question, no on-chain
workaround); `withdraw-build` stops when the vault's EVM account holds less than 0.001 ETH; caps per run
are ≤ 100 DUST, ≤ 0.02 Sepolia ETH and ≤ 10 of each token.

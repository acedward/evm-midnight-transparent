# Vendored vault records

These files are copied **byte for byte** from `acedward/passport` at
`6c7505a4d2ec223fce5eb10266c331576805465a` (the head of PR #4, the canonical Midnight bridge,
whose description names this commit), so the token registry is configuration taken from the
vault's own records. Do not edit them by hand: re-vendor them from a newer commit and update this
table and `test/tokens.test.ts`, which re-checks every SHA-256.

| File | Upstream path | Git blob | SHA-256 |
|---|---|---|---|
| `stagenet-vault.json` | `contract/contracts/erc20-vault/deployments/stagenet-vault.json` | `86f812064acdf8dfc35867fa45a030a9cfca89e1` | `8897b1eeb72bff8a5dd7038aca9556cc9308246352ef7e0a277a2f5024453a67` |
| `sepolia-stk.json` | `contract/contracts/erc20-vault/deployments/sepolia-stk.json` | `4ea866e05986c9ac3755d81e7accf3635df8e56f` | `0c9718001ad5e58ef7fb46de740ba1c9cd452d5257a465c6a4ada99918e7bee7` |
| `sepolia-tbill.json` | `contract/contracts/erc20-vault/deployments/sepolia-tbill.json` | `3f823b1ff82cb64ee9f33a8c801c0389ebb2b7cf` | `a34a79ca392d42a76ebcec0abb1cf023a059a0020a04f2dbf18a53ba64be839e` |
| `sepolia-test-tbills.json` | `contract/contracts/erc20-vault/deployments/sepolia-test-tbills.json` | `4b19da042631ffb241152b6e5d17674ce4207ee2` | `19e6a25d915ab9bd896b8e591a53a2f6bc187f0724fc412ec631040a4d10d672` |
| `../../vendor/vault-preflight.ts` | `contract/contracts/erc20-vault/src/preflight.ts` | `151d0471e90311d269839d8e8211c71cc39644aa` | `fe0c2ef038ce67219a257617c28a323eb9269ba56281a183b505bd52a31b32da` |

Vendored 2026-09-29 (project 00048 P0.3). The vault package is a fork of Sig Network's
MIT-licensed `midnight-examples` erc20-vault; the repository is Apache-2.0 (see `NOTICE`).

## What the code takes from them

- `stagenet-vault.json`: the vault (`vaultContractAddress`, `vaultEvmAddress`), the Signet
  singleton, the MPC root key and output cache, `explorer`, and `bridgedTokens`: every token the
  vault carries (ERC20 address, Midnight name and colour, decimals). This list is the registry:
  wStkA, wStkB, wStkC, wUSDC, TBILL, TB13W, TB26W and TB52W, all on vault `7771c9e5…cd637`, all
  6 decimals.
- `sepolia-stk.json`, `sepolia-tbill.json`, `sepolia-test-tbills.json`: the Sepolia ERC20s'
  symbols, names and decimals, each with the Midnight colour and vault it maps to. The registry
  refuses to build if any of them disagrees with `bridgedTokens`, and takes the ERC20's name
  from them. USDC is Circle's Sepolia token and has no record here; its name is its symbol.
- `vault-preflight.ts`: the vault client's pure underfunded-deposit refusal (`depositPreflight`),
  used by `bridge.ts`.

No token is special: the records carry no roles, and none are added here.

# Wallet test fixtures (public data only)

| File | What it is | Where it came from |
|---|---|---|
| `stagenet-bid-9ed57eec.json` | The ladder bid G-TAKE took live (maker gives 1 wUSDC, wants 104.166667 wStkA): its kernel record and `swapoffer1…` | `GET https://stagenet.api-zswap.zkdojo.com/v1/offers/9ed57eec…a00b`, 2026-09-29 (G-TAKE; the `token` field renamed `colour`) |
| `stagenet-vault-679357.json` | The stagenet vault's public state at block 679,357 (`61f577da…f445`, 2026-09-29 21:27:36 UTC): the vault's contract state, its Zswap state and the ledger parameters, and the Signet singleton's contract state, as the indexer's hex, verbatim | `bun packages/wallet/scripts/record-vault-fixture.ts 679357 …` (the queries midnight-js 5.0.0-beta.7's indexer provider sends, pinned to that block). It is the latest block when G-BRIDGE built its `startWithdraw` (B.3.1, 21:27:40 UTC): building on it with the gate's arguments must create the gate's live request `21d8b43d…2900` (vault request nonce 27) |
| `g-bridge-startwithdraw-proven.hex` | G-BRIDGE's proven, bound `startWithdraw` (the temporary wallet's half, 21,327 bytes, sha256 `140bdf04…89b2` of the bytes): what the sponsor received before adding DUST | The gate's state file `withdraw-start.tx` (B.3.1); it landed merged with the sponsor's DUST as `000ee2e4…960d` at block 679,385 |
| `g-bridge-complete-deposit.json` | G-BRIDGE's live `completeDeposit` (`cd388d63…9a99`, block 679,341; 16,203 bytes, sha256 in the file) with its identifiers and the coin it minted to the temporary wallet (nonce, colour, value; the coin and encryption public keys): public values only | `transactions(offset: {hash})` on the stagenet indexer (read-only, 2026-10-02, P4.2-fix4 FS4); the coin from the gate's evidence `b2-4-deposit-complete.json`. It shows that a settle discloses the minted coin's commitment, never its nonce (questions file Q16) |

The tests never touch the network: `test/helpers.ts` serves these through a `VaultStateReader` and
builds wallets whose shielded state holds chosen coins (the SDK's `ShieldedWallet`, restored from a
ledger `ZswapLocalState`, never started).

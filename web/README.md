# web

The app: connect an EVM wallet (Sepolia), see the live offers whose two legs the vault bridges, and run a swap through a temporary Midnight wallet made for that swap. A static site (React + Vite); every per-user record stays in the browser.

## Pages

- `#swap`: the offers list (every live offer with two vault-token legs, not expiring within 45 minutes; "you pay / you receive / price / expires"; live on the kernel's offer stream) and "Your swaps" (the connected wallet's swap records, with Resume).
- `#swap?offer=<id>`: the review, and Start swap.
- `#swap?id=<swap id>`: one swap's six stages with every hash: start (the "start swap" message signed twice, then the sponsor authorisation), send funds (the sized sweep ETH, then exactly the offer's amount, to the deposit address), bridge in, take (or "Swap is not available" + Bridge back), bridge out (or back), done.
- `#local`: Local data (Export, Import, CLEAR ALL). A swap record holds no secret: never the seed, a signature or the sponsor's token.

## The ports, mock and live

The pages use three ports (`src/swap/ports.ts`, the plan's "Lane contracts" as L-SPONSOR and L-WALLET answered them): the wallet module (drafts: `buildTake` → `/prove` → `finalizeTake` → `submitTake`; `withdraw-params` → `buildWithdraw` → `/prove` with its hints → `finalizeWithdraw` → `/withdraw`, rebuilt on a stale answer; every unsubmitted draft released), the sponsor API (`src/swap/sponsor-client.ts`, the real HTTP client) and the exchange (core's `KernelClient`). `src/swap/wiring.ts` picks them from `config.json`:

- with a `mock` block, the exchange, the sponsor and the wallet module run in the page on one mock chain (`src/swap/mock/`; a separate chunk). The sponsor and kernel clients are the real ones with the mocks' `fetch`. `deriveSwapSeed` is core's real one. Only a mock or test EVM wallet may send the swap's Sepolia transactions in mock mode.

  ```json
  { "network": "stagenet", "sponsorUrl": "", "mock": { "stepMs": 1500, "evmWallet": true } }
  ```

  `evmWallet: true` announces a built-in "Mock wallet (no real funds)"; `scenario` can set `offerGoneAtTake`, `refundFirstWithdrawal`, `staleWithdrawOnce` or `refuseOpen`; `book: "empty"`; `persist` (default true) keeps the mock world in localStorage (`emt-mock/world`) across a reload or a new tab. The specs steer it through `window.__emtMock`.

- without it (live), the real exchange and the sponsor at `sponsorUrl`, and `liveWalletModule()`, which cannot start a swap yet. P3 replaces it with `adaptWalletModule(await import('@evm-midnight-transparent/wallet'), network)` (`src/swap/live-wallet.ts`: the real module behind the same port, checked by the compiler and `test/live-wallet.test.ts`; call the module's `ensureBufferGlobal()` once) and deploys `config.json` without the `mock` block.

## Tests

- Unit (Vitest, `web/test/`): the session against the mock ports (every stage, determinism, not available + Bridge back, refunds, resume, refusals), the pure flow logic, the swap record and Import, the sponsor client, the design system and its contrast.
- Browser (Playwright, `test/e2e/`, in the `mcr.microsoft.com/playwright:v1.62.0-noble` image): `bun run e2e`. Screenshots at 1280 and 375 px go to `test-results/visual/`.

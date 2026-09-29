# evm-midnight-transparent

Swap on Midnight from an EVM wallet, with no Midnight wallet of your own.

A user connects an EVM wallet on Sepolia, picks a live offer from the ZSwap exchange on Midnight
stagenet, and signs. The app then:

1. creates a temporary Midnight wallet for this swap, in the browser;
2. bridges in exactly the amount the offer wants (Sepolia ERC20 to the Midnight vault);
3. takes the offer on Midnight;
4. bridges out what the offer gave, back to the user's EVM address.

A small sponsor service pays the Midnight fees of the bridge legs. It never holds a user's keys.

Status: work in progress. Test networks only (Midnight stagenet and Ethereum Sepolia); nothing
here carries real value.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

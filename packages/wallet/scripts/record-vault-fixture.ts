// Record the stagenet vault's public state at one block, for the offline `buildWithdraw` tests.
//
//   bun packages/wallet/scripts/record-vault-fixture.ts <height> <out.json>
//
// Read-only: three GraphQL queries to the stagenet indexer, the same ones midnight-js's indexer
// public data provider sends (`CONTRACT_AND_ZSWAP_STATE_QUERY` for the vault and `CONTRACT_STATE_QUERY`
// for the Signet singleton its `startWithdraw` calls), pinned to the block `<height>`. The indexer's
// hex is kept verbatim; the test parses it with midnight-js's own deserialisers.

import { writeFileSync } from 'node:fs';

import { STAGENET } from '@evm-midnight-transparent/core';

const [heightArg, out] = process.argv.slice(2);
if (!heightArg || !out) {
  console.error('usage: bun packages/wallet/scripts/record-vault-fixture.ts <height> <out.json>');
  process.exit(64);
}
const height = Number(heightArg);
const indexer = STAGENET.midnight.indexerUrl;
const vault = STAGENET.bridge.vaultAddress;
const singleton = STAGENET.bridge.signetSingleton;

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body: { data?: T; errors?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`indexer: HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || body.errors || !body.data)
    throw new Error(`indexer: HTTP ${res.status} ${JSON.stringify(body.errors)}`);
  return body.data;
}

const offset = { height };
const block = await gql<{ block: { height: number; hash: string; timestamp: number } }>(
  'query B($offset: BlockOffset) { block(offset: $offset) { height hash timestamp } }',
  { offset },
);
const pinned = { hash: block.block.hash };
const vaultState = await gql<{
  block: { ledgerParameters: string; contractZswapState: string };
  contract: { state: string };
}>(
  `query V($address: HexEncoded!, $offset: BlockOffset) {
    block(offset: $offset) { ledgerParameters contractZswapState(address: $address) }
    contract(address: $address, offset: $offset) { state }
  }`,
  { address: vault, offset: pinned },
);
const singletonState = await gql<{ contract: { state: string } }>(
  'query S($address: HexEncoded!, $offset: BlockOffset) { contract(address: $address, offset: $offset) { state } }',
  { address: singleton, offset: pinned },
);

writeFileSync(
  out,
  `${JSON.stringify(
    {
      capturedAt: new Date().toISOString(),
      source: `${indexer} (CONTRACT_AND_ZSWAP_STATE_QUERY / CONTRACT_STATE_QUERY, midnight-js 5.0.0-beta.7)`,
      network: 'stagenet',
      block: block.block,
      vault: {
        address: vault,
        state: vaultState.contract.state,
        contractZswapState: vaultState.block.contractZswapState,
        ledgerParameters: vaultState.block.ledgerParameters,
      },
      singleton: { address: singleton, state: singletonState.contract.state },
    },
    null,
    1,
  )}\n`,
);
console.log(`recorded block ${block.block.height} (${block.block.hash}) to ${out}`);

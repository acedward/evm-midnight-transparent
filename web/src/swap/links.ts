// Explorer links for a swap's hashes (L-WEB's reading, item 8; questions Q11):
//   - Sepolia transactions and addresses: the network profile's EVM explorer (Etherscan, Sepolia);
//   - bridge request ids: the sig-net explorer, which opens a request from `requestId=0x…`;
//   - Midnight transactions: `midnight.explorerUrl` when the deployment sets one (a `{hash}` template
//     or a base URL + `/tx/<hash>`); none is known for stagenet, so they stay copyable text.

import type { NetworkProfile } from '@evm-midnight-transparent/core';

const bare = (h: string) => h.replace(/^0x/, '').toLowerCase();

export function sepoliaTxUrl(p: NetworkProfile, hash: string): string {
  return `${p.evm.explorerUrl.replace(/\/+$/, '')}/tx/${hash}`;
}

export function sepoliaAddressUrl(p: NetworkProfile, address: string): string {
  return `${p.evm.explorerUrl.replace(/\/+$/, '')}/address/${address}`;
}

export function bridgeRequestUrl(p: NetworkProfile, requestId: string): string | undefined {
  const base = p.bridge.explorerUrl;
  if (!base) return undefined;
  return `${base}${base.includes('?') ? '&' : '?'}requestId=0x${bare(requestId)}`;
}

export function midnightTxUrl(p: NetworkProfile, hash: string): string | undefined {
  const base = p.midnight.explorerUrl;
  if (!base) return undefined;
  const h = bare(hash);
  return base.includes('{hash}') ? base.replace('{hash}', h) : `${base.replace(/\/+$/, '')}/tx/${h}`;
}

// A Midnight unshielded address (`mn_addr_<network>1…`), as the wallet SDK encodes it
// (@midnightntwrk/wallet-sdk-address-format `UnshieldedAddress`): bech32m over the 32-byte user
// address, which is the hash of the wallet's NIGHT verifying key (ledger `addressFromKey`).
// Browser-safe (no Buffer). The temporary wallet never holds NIGHT; its unshielded address only
// names the submitter in the batcher's envelope, as the zswap SPA sends it.

import { bech32m } from '@scure/base';

import { hexToBytes } from './hex.js';

export function formatUnshieldedAddress(addressHex: string, network: string): string {
  const bytes = hexToBytes(addressHex, 32);
  const prefix = network === 'mainnet' ? 'mn_addr' : `mn_addr_${network}`;
  return bech32m.encode(prefix, bech32m.toWords(bytes), false);
}

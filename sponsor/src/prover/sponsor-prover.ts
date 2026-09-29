// The sponsor's proving: MN Bank's streaming proof provider (./proving-provider.ts) over the vault's
// key directory, used two ways:
//   - as midnight-js's `proofProvider` for the sponsor's own vault calls (startDeposit, the settles);
//   - as the `/prove` route's prover: a swap's unproven transaction in, the proven one out. The
//     browser never downloads key material (plan "Lane contracts" item 4): vault circuits come from
//     the key directory, zswap spends and outputs from the proof server's built-in keys.

import * as ledger from '@midnightntwrk/ledger-v9';

import type { Logger } from '../log.js';
import type { SwapProver } from '../swaps/backend.js';
import { relayProofProvider, type RelayProofProvider } from './proving-provider.js';

/** A proof of a vault circuit can take minutes on a busy server. */
export const DEFAULT_SPONSOR_PROOF_TIMEOUT_MS = 900_000;

export async function streamingProver(
  proofServerUrl: string,
  managedDir: string,
  options: { timeout?: number | undefined; log?: Logger } = {},
): Promise<{ proofProvider: RelayProofProvider; swapProver: SwapProver }> {
  const proofProvider = await relayProofProvider(proofServerUrl, managedDir, {
    timeout: options.timeout ?? DEFAULT_SPONSOR_PROOF_TIMEOUT_MS,
    ...(options.log ? { log: options.log } : {}),
  });
  const swapProver: SwapProver = {
    async prove(unproven) {
      const tx = ledger.Transaction.deserialize('signature', 'pre-proof', 'pre-binding', unproven);
      const proven = (await proofProvider.proveTx(tx)) as { serialize(): Uint8Array };
      return proven.serialize();
    },
  };
  return { proofProvider, swapProver };
}

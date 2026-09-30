// Proving on a proof server (Q3 A: our own server; the sponsor's proof proxy in the product).
//
// The wallet SDK's server proving service posts each zswap spend and output to the server's
// `/prove` and returns the proven, pre-binding transaction. The server sees the temporary
// wallet's spend keys for the proof (accepted in Q3: the server is ours, the wallet disposable).
// Browser-safe: fetch only; the proof server serves CORS (checked in G-TAKE T.5).

import { type UnprovenTransaction } from '@midnightntwrk/ledger-v9';
import { makeServerProvingService, type UnboundTransaction } from '@midnightntwrk/wallet-sdk-capabilities/proving';

import { walletOutputsOf } from './outputs.js';
import type { SponsorClient } from './sponsor-client.js';
import type { TempWallet } from './temp-wallet.js';
import { type UnprovenTx, provenUnboundFromHex, txToHex } from './tx.js';

export interface ProvingService {
  prove(tx: UnprovenTransaction): Promise<UnboundTransaction>;
}

export function serverProvingService(proofServerUrl: string): ProvingService {
  return makeServerProvingService({ provingServerUrl: new URL(proofServerUrl) });
}

/** A `ProvingService` over the sponsor's `/prove` for takes (code written against the SDK's service).
 *  Given the temporary wallet, it discloses the take's outputs to it (P4.2-fix2 R1). */
export function sponsorProvingService(client: SponsorClient, purpose: 'take', wallet?: TempWallet): ProvingService {
  return {
    prove: async (tx: UnprovenTx) =>
      provenUnboundFromHex(
        await client.prove(
          purpose,
          txToHex(tx),
          undefined,
          wallet ? { walletOutputs: walletOutputsOf(wallet, tx) } : undefined,
        ),
      ),
  };
}

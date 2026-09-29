// What the wallet SDK expects from its host that a browser does not have.
//
// The SDK's address classes (@midnightntwrk/wallet-sdk-address-format) use Node's global `Buffer`:
// the shielded wallet's `state.address` and its transfer path (a `ShieldedAddress` receiver) throw
// "Buffer is not defined" in a browser (G-TAKE T.5). The take path itself does not touch them.
// Call `ensureBufferGlobal()` once at start-up in the web app, before the wallet builds a transfer.

import { Buffer } from 'buffer';

export function ensureBufferGlobal(): void {
  const g = globalThis as { Buffer?: unknown };
  if (g.Buffer === undefined) g.Buffer = Buffer;
}

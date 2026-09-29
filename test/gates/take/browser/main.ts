// G-TAKE T.5: the temporary wallet's code in a real browser (headless Chromium).
//
// The page exposes `window.gateRun(input)`, which the driver (browser-run.ts) calls with the swap
// seed it derived by signing (the seed lives in the page's memory only, as in the product):
//   1. a CORS probe of the proof server (a plain cross-origin GET of /version);
//   2. the shielded-only wallet synced from genesis (timed);
//   3. ONE proof request to the proof server: a self-transfer of the wallet's smallest balance,
//      built, proven, and then released, never submitted.
// It returns public numbers only.

import { firstValueFrom } from 'rxjs';

import { STAGENET } from '../../../../packages/core/src/network.js';
import {
  ensureBufferGlobal,
  openShieldedWallet,
  serverProvingService,
  temporaryWalletKeys,
} from '../../../../packages/wallet/src/index.js';

// The SDK's address classes need a global Buffer (packages/wallet/src/browser.ts).
ensureBufferGlobal();

interface GateInput {
  seedHex: string;
  proofServerUrl: string;
}

async function corsProbe(url: string): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/version`, { mode: 'cors' });
    return {
      ok: res.ok,
      status: res.status,
      body: (await res.text()).slice(0, 64),
      allowOrigin: res.headers.get('access-control-allow-origin'),
    };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

async function gateRun(input: GateInput): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {
    userAgent: navigator.userAgent,
    origin: location.origin,
    proofServer: input.proofServerUrl,
  };
  out.cors = await corsProbe(input.proofServerUrl);

  const keys = temporaryWalletKeys(input.seedHex, STAGENET.midnightNetworkId);
  out.shieldedAddress = keys.shieldedAddress;
  const t0 = performance.now();
  const w = await openShieldedWallet(keys.shieldedSecretKeys, {
    networkId: STAGENET.midnightNetworkId,
    indexerUrl: STAGENET.midnight.indexerUrl,
    indexerWsUrl: STAGENET.midnight.indexerWsUrl,
  });
  try {
    const synced = await w.waitSynced();
    out.syncSeconds = Math.round((performance.now() - t0) / 100) / 10;
    out.appliedIndex = Number(synced.progress.appliedIndex);
    out.latestIndex = Number(synced.progress.highestRelevantWalletIndex);
    const balances = await w.balances();
    out.balances = Object.fromEntries(Object.entries(balances).map(([c, v]) => [c, v.toString()]));

    const held = Object.entries(balances)
      .filter(([, v]) => v > 0n)
      .sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (held.length === 0) {
      out.proof = { skipped: 'the wallet holds nothing to spend' };
      return out;
    }
    const [colour, amount] = held[0]!;
    const self = (await firstValueFrom(w.wallet.state)).address;
    const unproven = await w.wallet.transferTransaction(keys.shieldedSecretKeys, [
      { type: colour, receiverAddress: self, amount },
    ]);
    try {
      const t1 = performance.now();
      const proven = await serverProvingService(input.proofServerUrl).prove(unproven);
      out.proof = {
        what: 'self-transfer (one zswap spend + outputs), proven and released, never submitted',
        colour,
        amount: amount.toString(),
        provingSeconds: Math.round((performance.now() - t1) / 100) / 10,
        provenBytes: proven.serialize().length,
      };
    } catch (e) {
      out.proof = { error: String((e as Error)?.message ?? e) };
    } finally {
      await w.wallet.revertTransaction(unproven).catch(() => undefined);
    }
    return out;
  } finally {
    await w.stop().catch(() => undefined);
    keys.clear();
  }
}

(window as unknown as { gateRun: typeof gateRun }).gateRun = gateRun;
document.getElementById('status')!.textContent = 'ready';

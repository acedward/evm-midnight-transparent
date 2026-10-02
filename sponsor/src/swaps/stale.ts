// The stale closer for the sponsor's OWN bridge requests (plan L-SPONSOR; spec US2 scenario 3).
//
// Every request this sponsor drives is recorded on its swap (./store.ts). A request can be left
// without a driver: the relayer loop timed out (the MPC signed late, Sepolia stalled), a settle
// failed for a moment (DUST contention), or the process restarted mid-run (the service resumes those
// at start-up, and this catches whatever that missed). An open withdrawal also holds the vault
// account's nonce, and an open deposit holds its swap's funds, so they must not wait for a user who
// may never come back.
//
// Every `intervalMs` the closer looks for swaps in `depositing`, `withdrawing` or `bridging_back`
// that nothing drives and that have not moved for `staleAfterMs`, and drives each again: the
// relayer loop is resumable, and the settle it ends with is permissionless (its mint, a refund, goes
// to the temporary wallet the vault's request names). It also settles every withdrawal attempt whose
// outcome is unknown by its request id, superseded ones included (audit R5): one that landed after
// all is adopted and driven, one that provably did not land is closed.
//
// It never touches a request that is not one of this sponsor's swaps. Its spending is capped: at
// most `maxPerDay` re-drives in any rolling 24 hours, and none while the sponsor's DUST is under
// `minSponsorDustSpecks` (users' own swaps keep priority); /health reports why it holds back.

import type { Logger } from '../log.js';
import type { SponsorStatus } from '../sponsor/session.js';
import type { SwapService } from './service.js';

export interface StaleCloserConfig {
  enabled: boolean;
  intervalMs: number;
  staleAfterMs: number;
  maxPerDay: number;
  minSponsorDustSpecks: bigint;
}

export interface StaleCloserStatus {
  enabled: boolean;
  lastScanAt: number | null;
  closed24h: number;
  maxPerDay: number;
  paused: string | null;
}

const DAY_MS = 86_400_000;

export class StaleCloser {
  private readonly spends: number[] = [];
  private lastScanAt: number | null = null;
  private paused: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly deps: {
      config: StaleCloserConfig;
      service: Pick<SwapService, 'stalled' | 'redrive' | 'adoptLateStarts'>;
      sponsor: () => SponsorStatus;
      log: Logger;
      now?: () => number;
    },
  ) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (!this.deps.config.enabled || this.timer) return;
    this.timer = setInterval(() => void this.scan(), this.deps.config.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): StaleCloserStatus {
    this.prune();
    return {
      enabled: this.deps.config.enabled,
      lastScanAt: this.lastScanAt === null ? null : Math.floor(this.lastScanAt / 1000),
      closed24h: this.spends.length,
      maxPerDay: this.deps.config.maxPerDay,
      paused: this.paused,
    };
  }

  private prune(): void {
    const since = this.now() - DAY_MS;
    while (this.spends.length > 0 && this.spends[0]! <= since) this.spends.shift();
  }

  private refusal(): string | null {
    this.prune();
    if (this.spends.length >= this.deps.config.maxPerDay)
      return `the daily cap of ${this.deps.config.maxPerDay} is reached`;
    const s = this.deps.sponsor();
    if (!s.synced) return 'the sponsor wallet is not synced';
    if (s.dustSpecks !== null && s.dustSpecks < this.deps.config.minSponsorDustSpecks) {
      return "the sponsor's DUST is below the closer's reserve";
    }
    return null;
  }

  /** One pass (the timer calls it; tests call it directly). */
  scan(): Promise<void> {
    if (!this.deps.config.enabled) return Promise.resolve();
    this.scanning ??= this.scanOnce()
      .catch((e: unknown) => this.deps.log.warn('stale scan failed', { error: e }))
      .finally(() => {
        this.scanning = null;
      });
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    const now = this.now();
    this.lastScanAt = now;
    const olderThan = Math.floor((now - this.deps.config.staleAfterMs) / 1000);
    // An adopted late start is driven to its settle, which the sponsor pays: it takes the same
    // daily cap and DUST reserve as a re-drive, and counts as one (audit C12, F-B11).
    const before = this.refusal();
    if (before) {
      this.paused = before;
      return;
    }
    this.prune();
    const room = this.deps.config.maxPerDay - this.spends.length;
    const adopted = await this.deps.service.adoptLateStarts(Math.floor((now - 3_600_000) / 1000), room);
    for (const id of adopted) {
      this.spends.push(this.now());
      this.deps.log.info('late withdrawal start adopted', { swapId: id });
    }
    for (const rec of this.deps.service.stalled(olderThan)) {
      const refusal = this.refusal();
      this.paused = refusal;
      if (refusal) return;
      if (this.deps.service.redrive(rec)) {
        this.spends.push(this.now());
        this.deps.log.info('stale swap driven again', { swapId: rec.swapId, state: rec.state });
      }
    }
    this.paused = null;
  }
}

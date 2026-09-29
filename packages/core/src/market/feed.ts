// The live offer book: reads every live offer from the exchange, keeps the ones this app can swap
// (./book.ts), and keeps them fresh on the kernel's offer stream, polling when the stream is down.
//
// Adapted from MN Bank's markets feed (acedward/passport-evm-dapp @ 911647b,
// packages/core/src/market/feed.ts): one refresh is the whole live book (`/v1/offers`,
// keyset-paged, no token filter: no token is special), with no pair or chart statistics.
//
// Cadence: an offer event on the stream triggers a (debounced) refresh, with a slow safety
// refresh while the stream is live; without the stream the feed polls. A 429 cool-down stretches
// the next refresh. At the defaults a refresh is one or a few requests (100 offers a page), far
// inside the kernel's 600 a minute.

import type { TokenRegistry } from '../tokens/registry.js';
import { KernelError, type KernelClient } from './kernel-client.js';
import { type BookSnapshot, deriveBook } from './book.js';
import { BOOK_EVENTS } from './wire.js';

export type StreamState = 'off' | 'connecting' | 'live' | 'polling';

export type FeedState =
  | { status: 'loading'; stream: StreamState }
  | {
      status: 'ready';
      snapshot: BookSnapshot;
      /** False when the book had more pages than the feed reads (`maxPages`). */
      complete: boolean;
      /** Offer rows the app could not read. */
      skipped: number;
      updatedAt: number;
      stream: StreamState;
    }
  | {
      /** The book could not be read: "exchange unavailable". Offers are not shown stale. */
      status: 'unavailable';
      reason: string;
      since: number;
      lastUpdatedAt: number | null;
      stream: StreamState;
    };

export interface OfferFeedOptions {
  client: KernelClient;
  registry: TokenRegistry;
  /** Follow `/v1/offers/stream` (default true). */
  useStream?: boolean;
  /** Refresh interval while the stream is down, ms (default 15 s). */
  pollMs?: number;
  /** Refresh interval while the stream is live, ms (default 60 s). */
  safetyRefreshMs?: number;
  /** Quiet time after an offer event before refreshing, ms (default 750). */
  debounceMs?: number;
  /** First stream reconnect delay, ms (default 5 s); doubles up to `maxReconnectMs`. */
  reconnectMs?: number;
  maxReconnectMs?: number;
  /** Book pages read per refresh, 100 offers each (default 20). */
  maxPages?: number;
  now?: () => number;
}

/** A short, user-facing reason for "exchange unavailable". */
export function describeKernelError(err: unknown): string {
  if (!(err instanceof KernelError)) return 'the exchange could not be read';
  switch (err.kind) {
    case 'timeout':
    case 'network':
      return 'the exchange did not answer';
    case 'rate-limited':
      return 'the exchange asked this browser to slow down';
    case 'invalid-response':
      return 'the exchange sent data this app cannot read';
    case 'http':
      return `the exchange answered ${err.details.status ?? 'with an error'}`;
    case 'aborted':
      return 'the request was cancelled';
  }
}

export class OfferFeed {
  private readonly client: KernelClient;
  private readonly registry: TokenRegistry;
  private readonly useStream: boolean;
  private readonly pollMs: number;
  private readonly safetyRefreshMs: number;
  private readonly debounceMs: number;
  private readonly reconnectMs: number;
  private readonly maxReconnectMs: number;
  private readonly maxPages: number;
  private readonly now: () => number;

  private state: FeedState = { status: 'loading', stream: 'off' };
  private readonly listeners = new Set<() => void>();
  private running = false;
  private abort: AbortController | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private stream: StreamState = 'off';
  private reconnectDelay: number;
  private streamOpenedBefore = false;
  /** Refreshes completed since start (for tests and diagnostics). */
  refreshes = 0;

  constructor(options: OfferFeedOptions) {
    this.client = options.client;
    this.registry = options.registry;
    this.useStream = options.useStream ?? true;
    this.pollMs = options.pollMs ?? 15_000;
    this.safetyRefreshMs = options.safetyRefreshMs ?? 60_000;
    this.debounceMs = options.debounceMs ?? 750;
    this.reconnectMs = options.reconnectMs ?? 5_000;
    this.maxReconnectMs = options.maxReconnectMs ?? 60_000;
    this.maxPages = options.maxPages ?? 20;
    this.now = options.now ?? Date.now;
    this.reconnectDelay = this.reconnectMs;
  }

  getState(): FeedState {
    return this.state;
  }

  /** Called after every state change. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.streamOpenedBefore = false;
    this.reconnectDelay = this.reconnectMs;
    void this.refresh();
    if (this.useStream) this.connect();
    else this.setStream('polling');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    clearTimeout(this.refreshTimer);
    clearTimeout(this.debounceTimer);
    clearTimeout(this.reconnectTimer);
    this.setStream('off');
  }

  /** Refresh now; a refresh requested while one runs is coalesced into one more after it. */
  refresh(): Promise<void> {
    if (!this.running) return Promise.resolve();
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        do {
          this.again = false;
          await this.readOnce();
        } while (this.again && this.running);
      } finally {
        this.inFlight = null;
        this.schedule();
      }
    })();
    return this.inFlight;
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }

  private setState(next: FeedState): void {
    this.state = next;
    this.emit();
  }

  private setStream(stream: StreamState): void {
    if (this.stream === stream) return;
    this.stream = stream;
    this.setState({ ...this.state, stream });
  }

  private async readOnce(): Promise<void> {
    const signal = this.abort?.signal;
    let book: Awaited<ReturnType<KernelClient['allOffers']>>;
    try {
      book = await this.client.allOffers({ maxPages: this.maxPages }, signal);
    } catch (err) {
      if (!this.running) return;
      this.refreshes++;
      const at = this.now();
      const prev = this.state;
      this.setState({
        status: 'unavailable',
        reason: describeKernelError(err),
        since: prev.status === 'unavailable' ? prev.since : at,
        lastUpdatedAt:
          prev.status === 'ready' ? prev.updatedAt : prev.status === 'unavailable' ? prev.lastUpdatedAt : null,
        stream: this.stream,
      });
      return;
    }
    if (!this.running) return;
    this.refreshes++;
    this.setState({
      status: 'ready',
      snapshot: deriveBook(book.offers, this.registry),
      complete: book.complete,
      skipped: book.skipped,
      updatedAt: this.now(),
      stream: this.stream,
    });
  }

  /** The next timed refresh: slow while the stream is live, the poll interval otherwise, and
   *  never before a 429 cool-down ends. */
  private schedule(): void {
    clearTimeout(this.refreshTimer);
    if (!this.running) return;
    const base = this.stream === 'live' ? this.safetyRefreshMs : this.pollMs;
    const delay = Math.max(base, this.client.cooldownRemaining());
    this.refreshTimer = setTimeout(() => void this.refresh(), delay);
  }

  private onBookEvent(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.refresh(), this.debounceMs);
  }

  private connect(): void {
    if (!this.running || !this.abort) return;
    this.setStream('connecting');
    const signal = this.abort.signal;
    this.client
      .offerStream(
        {
          onOpen: () => {
            this.reconnectDelay = this.reconnectMs;
            this.setStream('live');
            if (this.streamOpenedBefore)
              void this.refresh(); // catch up on events missed while down
            else if (!this.inFlight) this.schedule(); // switch to the slow cadence
            this.streamOpenedBefore = true;
          },
          onEvent: (ev) => {
            if (BOOK_EVENTS.has(ev.type)) this.onBookEvent();
          },
        },
        signal,
      )
      .then(
        () => this.streamEnded(null),
        (err: unknown) => this.streamEnded(err),
      );
  }

  private streamEnded(err: unknown): void {
    if (!this.running) return;
    this.setStream('polling');
    if (!this.inFlight) this.schedule();
    const hinted = err instanceof KernelError ? (err.details.retryAfterMs ?? 0) : 0;
    const delay = Math.max(this.reconnectDelay, hinted);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectMs);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

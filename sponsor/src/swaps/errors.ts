// An error a swap route answers with: its HTTP status, a stable code (core swap-api.ts
// SWAP_ERRORS or a generic one) and a sentence the page may show. Anything else is an internal
// error, whose details go to the (redacted) log only.

export type SwapErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503;

export class SwapError extends Error {
  override name = 'SwapError';
  constructor(
    readonly status: SwapErrorStatus,
    readonly code: string,
    message: string,
    readonly detail?: string,
    /** Seconds the caller should wait before trying again (the Retry-After header). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** An error a background drive records on the swap (public code and message). */
export class DriveError extends Error {
  override name = 'DriveError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A server that ran at least this long before asking for a restart counts as healthy: the backoff starts over. */
export const STABLE_MS = 30_000;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

/**
 * Delay before the supervisor starts the server again after exit code 75. A normal restart (update, "Restart" in the UI)
 * happens after a long run and is immediate. A server that keeps asking for a restart right after starting (crash loop,
 * e.g. an update left broken code that exits with 75 on boot) is restarted after 1 s, 2 s, 4 s … at most 60 s apart.
 * No dependencies: the supervisor is not replaced by an update and must stay tiny.
 */
export class RestartBackoff {
  private quickRestarts = 0;

  /** @param uptimeMs how long the server ran before it exited. Returns the delay in ms. */
  next(uptimeMs: number): number {
    if (uptimeMs >= STABLE_MS) {
      this.quickRestarts = 0;
      return 0;
    }
    this.quickRestarts++;
    return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (this.quickRestarts - 1));
  }
}

/**
 * A per-connection budget for socket events. HTTP limits don't reach these, because a socket is one long connection,
 * and a bucket suits them better than a fixed window: bursts of real typing pass, and only sustained floods are refused.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
  }

  take(now = Date.now()): boolean {
    // A clock can step backwards, and that must not drain the bucket.
    const elapsedSeconds = Math.max(0, now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.updatedAt = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

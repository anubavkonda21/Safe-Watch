/**
 * Fixed-window request limiter with bounded memory. Each key has a counter for the current window; when the number of
 * distinct keys reaches `maxKeys`, the least recently used key is dropped (so an attacker cannot make the map grow
 * without bound, at the price of resetting that key's counter). In memory only: it resets when the server restarts and
 * is not shared between processes. A real deployment behind several processes needs a shared limiter.
 */
export class RateLimiter {
  private readonly entries = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly options: { limit: number; windowMs: number; maxKeys: number; now?: () => number }) {}

  /** Records one request for `key`. `retryAfterMs` is how long until the window resets when denied. */
  hit(key: string): { allowed: boolean; remaining: number; retryAfterMs: number } {
    const now = (this.options.now ?? Date.now)();
    const { limit, windowMs, maxKeys } = this.options;
    let e = this.entries.get(key);
    if (e && now - e.windowStart >= windowMs) e = undefined;
    if (e) {
      this.entries.delete(key); // refresh LRU position
    } else {
      this.evict(now);
      while (this.entries.size >= maxKeys) {
        const oldest = this.entries.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
      e = { windowStart: now, count: 0 };
    }
    e.count += 1;
    this.entries.set(key, e);
    const allowed = e.count <= limit;
    return { allowed, remaining: Math.max(0, limit - e.count), retryAfterMs: allowed ? 0 : Math.max(1, e.windowStart + windowMs - now) };
  }

  private lastEvict = 0;
  /** Drops windows that have ended (at most once per window, so the cost is amortised). */
  private evict(now: number) {
    if (now - this.lastEvict < this.options.windowMs) return;
    this.lastEvict = now;
    for (const [k, v] of this.entries) if (now - v.windowStart >= this.options.windowMs) this.entries.delete(k);
  }

  get size() { return this.entries.size; }
}

/**
 * Simple in-memory sliding window rate limiter.
 *
 * Lives on the Worker isolate (not in a DO), so limits are
 * approximate / per-isolate. Good enough for abuse prevention.
 */
export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  check(key: string, limit: number, windowMs: number): { allowed: boolean; remaining: number; retryAfter?: number } {
    const now = Date.now();
    const entry = this.windows.get(key);
    if (!entry || now > entry.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1 };
    }
    if (entry.count >= limit) {
      return { allowed: false, remaining: 0, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
    }
    entry.count++;
    return { allowed: true, remaining: limit - entry.count };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.windows) {
      if (now > entry.resetAt) this.windows.delete(key);
    }
  }
}

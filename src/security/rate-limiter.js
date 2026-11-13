// ============================================================================
// TripMozy Security Suite: Rate Limiter & Brute Force Protection
// In-memory sliding window rate limiter for auth, OTP & sensitive endpoints
// ============================================================================

class RateLimiter {
  constructor() {
    // Map of key -> array of timestamps
    this.hits = new Map();
    // Map of key -> { count: number, lockedUntil: number }
    this.locks = new Map();

    // Auto-clean stale entries every 5 minutes
    if (typeof setInterval !== 'undefined') {
      const timer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
      if (timer.unref) timer.unref();
    }
  }

  /**
   * Check if an action is allowed under rate limit
   * @param {string} key - Unique identifier (e.g. `ip:127.0.0.1:login` or `email:user@x.com:otp`)
   * @param {number} maxAttempts - Maximum attempts allowed in window
   * @param {number} windowMs - Time window in milliseconds
   * @param {number} lockoutMs - Lockout duration in milliseconds if exceeded (optional)
   * @returns {{ allowed: boolean, remaining: number, retryAfterSeconds: number }}
   */
  checkLimit(key, maxAttempts, windowMs, lockoutMs = 0) {
    const now = Date.now();

    // Check if currently locked
    const lock = this.locks.get(key);
    if (lock && lock.lockedUntil > now) {
      const retryAfterSeconds = Math.ceil((lock.lockedUntil - now) / 1000);
      return { allowed: false, remaining: 0, retryAfterSeconds };
    } else if (lock && lock.lockedUntil <= now) {
      this.locks.delete(key);
    }

    // Get existing timestamps
    const timestamps = this.hits.get(key) || [];
    // Filter timestamps within window
    const recent = timestamps.filter(t => (now - t) < windowMs);

    if (recent.length >= maxAttempts) {
      if (lockoutMs > 0) {
        this.locks.set(key, { lockedUntil: now + lockoutMs });
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.ceil(lockoutMs / 1000)
        };
      }
      const oldestInWindow = recent[0];
      const retryAfterSeconds = Math.ceil((windowMs - (now - oldestInWindow)) / 1000);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, retryAfterSeconds)
      };
    }

    // Record this attempt
    recent.push(now);
    this.hits.set(key, recent);

    return {
      allowed: true,
      remaining: maxAttempts - recent.length,
      retryAfterSeconds: 0
    };
  }

  /**
   * Reset rate limit bucket on successful action
   * @param {string} key
   */
  reset(key) {
    this.hits.delete(key);
    this.locks.delete(key);
  }

  /**
   * Prune expired buckets
   */
  cleanup() {
    const now = Date.now();
    for (const [key, lock] of this.locks.entries()) {
      if (lock.lockedUntil <= now) this.locks.delete(key);
    }
    for (const [key, timestamps] of this.hits.entries()) {
      // Keep only timestamps from last 1 hour
      const valid = timestamps.filter(t => (now - t) < 60 * 60 * 1000);
      if (valid.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, valid);
      }
    }
  }
}

const rateLimiter = new RateLimiter();

module.exports = { RateLimiter, rateLimiter };

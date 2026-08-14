// lib/rate-limit.mjs
//
// In-memory fixed-window rate limiter, keyed by api-key id.
//
// Design:
//   - Bucket: `${keyId}:${windowStart}` where windowStart = floor(now/window).
//   - On each request: increment counter for the current bucket. If it
//     exceeds the cap, deny. Otherwise allow.
//   - Old buckets are lazily reaped when we see a request for a new window;
//     no timer needed.
//   - Counters reset on process restart (accepted trade-off for MVP;
//     a redis-backed impl comes later).
//
// Not covered here:
//   - Distributed rate limiting (would need Redis / a shared store)
//   - Token bucket for burst tolerance (fixed window is stricter)
//   - Per-endpoint different caps (all endpoints share one cap in v1)
//   - Global (unauthenticated) rate limit — that's a different concern

const DEFAULT_CAP_PER_MINUTE = 60;
const WINDOW_SECONDS = 60;

// Map<string, { count: number, windowStart: number }>
const state = new Map();

let cap = DEFAULT_CAP_PER_MINUTE;

/**
 * Configure the rate limiter. Call once at startup if you want a
 * non-default cap. Reads RATE_LIMIT_PER_MINUTE from the environment.
 */
export function initRateLimiter({ perMinute } = {}) {
  const envVal = Number(process.env.RATE_LIMIT_PER_MINUTE);
  if (Number.isFinite(envVal) && envVal > 0) {
    cap = Math.floor(envVal);
  } else if (Number.isFinite(perMinute) && perMinute > 0) {
    cap = Math.floor(perMinute);
  } else {
    cap = DEFAULT_CAP_PER_MINUTE;
  }
  state.clear();
  return { cap, windowSeconds: WINDOW_SECONDS };
}

/**
 * Check whether this key can make another request right now.
 * Returns { allowed, remaining, retryAfterSec, resetAt }.
 * On `allowed=true`, the counter is incremented as a side effect.
 */
export function checkRateLimit(keyId) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / WINDOW_SECONDS) * WINDOW_SECONDS;
  const resetAt = windowStart + WINDOW_SECONDS;

  const bucket = state.get(String(keyId));
  if (!bucket || bucket.windowStart !== windowStart) {
    // First request in a fresh window
    state.set(String(keyId), { count: 1, windowStart });
    return {
      allowed: true,
      remaining: cap - 1,
      retryAfterSec: 0,
      resetAt,
      cap,
    };
  }

  if (bucket.count >= cap) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: resetAt - now,
      resetAt,
      cap,
    };
  }

  bucket.count += 1;
  return {
    allowed: true,
    remaining: cap - bucket.count,
    retryAfterSec: 0,
    resetAt,
    cap,
  };
}

/**
 * Introspection helper for tests / debugging. Returns the raw counter
 * for a key without incrementing.
 */
export function _peekCount(keyId) {
  const bucket = state.get(String(keyId));
  return bucket ? bucket.count : 0;
}

/**
 * For tests: reset all counters.
 */
export function _resetForTests() {
  state.clear();
}

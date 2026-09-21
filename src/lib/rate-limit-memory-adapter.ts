/**
 * In-memory sliding-window rate limiter -- extracted verbatim (zero
 * behavioral change) from the original single-file src/lib/rate-limit.ts,
 * as part of Security Hardening Phase F, Commit B.
 *
 * This remains genuinely useful in three roles, not merely legacy code:
 *   1. the local-development implementation (no distributed backend
 *      needed to run the app locally);
 *   2. the degraded-but-safe fallback when the distributed backend is
 *      unconfigured, unreachable, or errors (see rate-limit.ts) -- a
 *      distributed-backend outage therefore degrades production to
 *      exactly this file's behavior, never to "no limiting at all";
 *   3. the reference implementation the test suite's exact-limit/window
 *      assertions are written against.
 *
 * KNOWN LIMITATION (unchanged from before this phase): state lives in
 * process memory. On a serverless platform (Vercel) each invocation may
 * hit a different instance, so this alone does not provide a real global
 * limit in production -- see rate-limit-distributed-adapter.ts for that.
 */

const hits = new Map<string, number[]>()

export interface RateLimitResult {
  allowed: boolean
  remaining: number
}

export function checkRateLimitMemory(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  const windowStart = now - windowMs
  const timestamps = (hits.get(key) ?? []).filter((t) => t > windowStart)

  if (timestamps.length >= limit) {
    hits.set(key, timestamps)
    return { allowed: false, remaining: 0 }
  }

  timestamps.push(now)
  hits.set(key, timestamps)
  return { allowed: true, remaining: limit - timestamps.length }
}

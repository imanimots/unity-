/**
 * Rate limiter public entry point -- Security Hardening Phase F, Commit B.
 *
 * The exported API is unchanged in shape from before this phase:
 * `checkRateLimit(key, limit, windowMs) -> { allowed, remaining }`, and
 * `getClientKey(request)` is untouched. The one necessary breaking
 * change is that `checkRateLimit` is now `async` (it may make a network
 * call to the distributed backend) -- every one of this repository's 80+
 * call sites was mechanically updated to `await` it as part of this
 * same commit.
 *
 * checkRateLimitDistributed() (rate-limit-distributed-adapter.ts)
 * already contains its own "not configured" / "backend failed" fallback
 * to checkRateLimitMemory() (rate-limit-memory-adapter.ts) -- this file
 * stays a thin, stable re-export so callers never need to know which
 * backend actually served a given request.
 */

import { checkRateLimitDistributed } from './rate-limit-distributed-adapter'

export type { RateLimitResult } from './rate-limit-memory-adapter'

export async function checkRateLimit(key: string, limit: number, windowMs: number) {
  return checkRateLimitDistributed(key, limit, windowMs)
}

export function getClientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() ?? 'unknown'
}

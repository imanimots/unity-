/**
 * Minimal in-memory sliding-window rate limiter.
 *
 * KNOWN LIMITATION: state lives in process memory. On a serverless platform
 * (Vercel) each invocation may hit a different instance, so this does not
 * provide a real global limit in production — it only helps within a single
 * long-lived process (local dev, a persistent Node server). It's included
 * as defense-in-depth for Phase 1; production hardening should replace this
 * with a shared store (e.g. Upstash Redis) — see docs/PHASE_1_REPORT.md.
 */

const hits = new Map<string, number[]>()

export interface RateLimitResult {
  allowed: boolean
  remaining: number
}

export function checkRateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
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

export function getClientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  return forwarded?.split(',')[0]?.trim() ?? 'unknown'
}

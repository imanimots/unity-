import { Redis } from '@upstash/redis'
import { checkRateLimitMemory, type RateLimitResult } from './rate-limit-memory-adapter'

/**
 * Distributed rate-limit backend (Security Hardening Phase F, Commit B) --
 * Upstash Redis via its serverless REST client. Closes the gap
 * documented in rate-limit-memory-adapter.ts: a real, cross-instance,
 * cross-region limit on Vercel, not just within one process.
 *
 * Design decisions (see Security Hardening Phase E's design report for
 * the full rationale):
 *   - Atomic fixed-window counter via a single Lua EVAL (INCR + EXPIRE
 *     only on first hit) -- never a GET-then-SET pair, which would be
 *     race-prone under concurrent serverless invocations.
 *   - The client identifier (IP) is SHA-256 hashed before it ever
 *     becomes part of the Redis key -- raw IPs are never persisted.
 *     The leading domain/action label (everything before the first
 *     ":") is kept in the clear so the key namespace stays observable
 *     (e.g. a spike under "bookings" is visible without decrypting
 *     anything) -- only the client-identifying suffix is opaque.
 *   - Any failure (missing credentials, network error, timeout,
 *     malformed response) transparently falls back to the in-memory
 *     adapter -- a distributed-backend outage degrades to exactly
 *     today's already-shipped behavior, never to "no limit" and never
 *     to a hard route failure.
 */

const LUA_INCR_WITH_TTL = `
local current = redis.call("INCR", KEYS[1])
if current == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return current
`

let client: Redis | null | undefined // undefined = not yet resolved, null = not configured

function getClient(): Redis | null {
  if (client !== undefined) return client

  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  // Never construct a live client when credentials are absent -- the
  // Upstash database may not be provisioned yet (expected during local
  // dev and in this repository's current state), and constructing the
  // client itself performs no network call, but we still gate it so
  // there is never an attempt to use a client built from empty strings.
  client = url && token ? new Redis({ url, token }) : null
  return client
}

async function hashClientKey(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

/**
 * Splits the caller's composite key ("domain:action:clientKey") into an
 * observable label (everything before the first ":") and the remainder
 * to be hashed as one opaque unit. Splitting on the FIRST colon only
 * (rather than the last) is deliberate: getClientKey() can return an
 * IPv6 address, which itself contains colons, so splitting on the last
 * colon would misparse it -- the app's own key-construction convention
 * always starts with a colon-free domain label, so the first colon is
 * unambiguous.
 */
function splitKey(key: string): { label: string; rest: string } {
  const i = key.indexOf(':')
  if (i === -1) return { label: key, rest: '' }
  return { label: key.slice(0, i), rest: key.slice(i + 1) }
}

export async function checkRateLimitDistributed(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const redis = getClient()
  if (!redis) return checkRateLimitMemory(key, limit, windowMs)

  try {
    const { label, rest } = splitKey(key)
    const hashed = await hashClientKey(rest)
    const redisKey = `ratelimit:${label}:${hashed}`
    const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000))

    const current = await redis.eval<[string], number>(LUA_INCR_WITH_TTL, [redisKey], [String(windowSeconds)])

    if (typeof current !== 'number') {
      // Defensive: a malformed/unexpected response is treated the same
      // as any other backend failure -- fail to the memory adapter
      // rather than trust an unexpected shape.
      console.error('rate-limit distributed backend returned an unexpected response shape')
      return checkRateLimitMemory(key, limit, windowMs)
    }

    return { allowed: current <= limit, remaining: Math.max(0, limit - current) }
  } catch {
    // Sanitized metadata only -- never the key (which could embed a
    // client identifier before hashing failed), never a URL, never a
    // token, never the raw backend response.
    console.error('rate-limit distributed backend unavailable')
    return checkRateLimitMemory(key, limit, windowMs)
  }
}

/** Test-only: resets the lazily-resolved client so a test can simulate a fresh module state. Not exported from rate-limit.ts. */
export function __resetDistributedClientForTests(): void {
  client = undefined
}

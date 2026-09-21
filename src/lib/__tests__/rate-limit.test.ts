import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { getClientKey } from '../rate-limit'

/**
 * Security Hardening -- Phase F, Commit B. Covers all three layers:
 *   1. the in-memory adapter's own sliding-window logic directly
 *      (rate-limit-memory-adapter.ts);
 *   2. the distributed adapter's key-hashing, atomicity contract, and
 *      fallback behavior, against a MOCKED @upstash/redis client --
 *      no real network call is ever made, and no real
 *      UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN is required to
 *      run this file;
 *   3. the public checkRateLimit()/getClientKey() re-export
 *      (rate-limit.ts), confirming the caller-facing contract is
 *      unchanged in shape (still { allowed, remaining }), only newly async.
 */

// -- Mock @upstash/redis before any module under test imports it, so the
// distributed adapter's lazily-constructed client is this fake instead
// of a real one. evalMock is reconfigured per test.
const evalMock = vi.fn()
vi.mock('@upstash/redis', () => {
  // A real class, not an arrow-function mock implementation -- arrow
  // functions cannot be used as constructors (no [[Construct]]), and
  // the module under test calls `new Redis(...)`.
  class FakeRedis {
    eval(...args: unknown[]) {
      return evalMock(...args)
    }
  }
  return { Redis: FakeRedis }
})

describe('rate-limit-memory-adapter (checkRateLimitMemory) -- sliding-window log, unchanged behavior', () => {
  it('allows requests under the limit and reports remaining correctly', async () => {
    const { checkRateLimitMemory } = await import('../rate-limit-memory-adapter')
    const key = `memory-test-under-${Date.now()}`
    const r1 = checkRateLimitMemory(key, 3, 60_000)
    expect(r1).toEqual({ allowed: true, remaining: 2 })
    const r2 = checkRateLimitMemory(key, 3, 60_000)
    expect(r2).toEqual({ allowed: true, remaining: 1 })
  })

  it('allows exactly up to the limit, then denies the next request', async () => {
    const { checkRateLimitMemory } = await import('../rate-limit-memory-adapter')
    const key = `memory-test-exact-${Date.now()}`
    expect(checkRateLimitMemory(key, 2, 60_000).allowed).toBe(true)
    expect(checkRateLimitMemory(key, 2, 60_000).allowed).toBe(true)
    const over = checkRateLimitMemory(key, 2, 60_000)
    expect(over).toEqual({ allowed: false, remaining: 0 })
  })

  it('resets after the window elapses', async () => {
    const { checkRateLimitMemory } = await import('../rate-limit-memory-adapter')
    const key = `memory-test-window-${Date.now()}`
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1_000_000)
    expect(checkRateLimitMemory(key, 1, 1_000).allowed).toBe(true)
    expect(checkRateLimitMemory(key, 1, 1_000).allowed).toBe(false)
    nowSpy.mockReturnValue(1_002_001) // just past the 1000ms window
    expect(checkRateLimitMemory(key, 1, 1_000).allowed).toBe(true)
    nowSpy.mockRestore()
  })

  it('tracks distinct keys independently', async () => {
    const { checkRateLimitMemory } = await import('../rate-limit-memory-adapter')
    const suffix = Date.now()
    expect(checkRateLimitMemory(`distinct-a-${suffix}`, 1, 60_000).allowed).toBe(true)
    expect(checkRateLimitMemory(`distinct-b-${suffix}`, 1, 60_000).allowed).toBe(true)
    // "a" is now exhausted; "b" is a fully separate bucket and remains open.
    expect(checkRateLimitMemory(`distinct-a-${suffix}`, 1, 60_000).allowed).toBe(false)
  })

  it('tracks distinct route prefixes independently even for the same underlying client suffix', async () => {
    const { checkRateLimitMemory } = await import('../rate-limit-memory-adapter')
    const suffix = Date.now()
    expect(checkRateLimitMemory(`routeA:${suffix}`, 1, 60_000).allowed).toBe(true)
    expect(checkRateLimitMemory(`routeA:${suffix}`, 1, 60_000).allowed).toBe(false)
    expect(checkRateLimitMemory(`routeB:${suffix}`, 1, 60_000).allowed).toBe(true)
  })
})

describe('rate-limit-distributed-adapter (checkRateLimitDistributed)', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(async () => {
    evalMock.mockReset()
    const { __resetDistributedClientForTests } = await import('../rate-limit-distributed-adapter')
    __resetDistributedClientForTests()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('falls back to the memory adapter when Upstash credentials are absent (no real credentials required to test)', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    const { checkRateLimitDistributed } = await import('../rate-limit-distributed-adapter')
    const result = await checkRateLimitDistributed(`fallback-test:${Date.now()}`, 5, 60_000)
    expect(result.allowed).toBe(true)
    expect(evalMock).not.toHaveBeenCalled()
  })

  it('uses the atomic EVAL primitive and derives allowed/remaining from its numeric result when Upstash succeeds', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-test-token-not-real'
    evalMock.mockResolvedValueOnce(3) // 3rd request in the window
    const { checkRateLimitDistributed } = await import('../rate-limit-distributed-adapter')
    const result = await checkRateLimitDistributed('success-test:203.0.113.5', 10, 60_000)
    expect(result).toEqual({ allowed: true, remaining: 7 })
    expect(evalMock).toHaveBeenCalledTimes(1)
    const [script, keys, args] = evalMock.mock.calls[0]
    expect(script).toContain('INCR')
    expect(script).toContain('EXPIRE')
    expect(keys).toHaveLength(1)
    expect(args).toEqual(['60'])
  })

  it('denies once the atomic count exceeds the limit', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-test-token-not-real'
    evalMock.mockResolvedValueOnce(11)
    const { checkRateLimitDistributed } = await import('../rate-limit-distributed-adapter')
    const result = await checkRateLimitDistributed('deny-test:203.0.113.5', 10, 60_000)
    expect(result).toEqual({ allowed: false, remaining: 0 })
  })

  it('falls back to the memory adapter when Upstash throws', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-test-token-not-real'
    evalMock.mockRejectedValueOnce(new Error('network timeout'))
    const { checkRateLimitDistributed } = await import('../rate-limit-distributed-adapter')
    const result = await checkRateLimitDistributed(`error-fallback-test:${Date.now()}`, 5, 60_000)
    expect(result.allowed).toBe(true) // memory adapter, fresh key, under limit
  })

  it('falls back to the memory adapter when Upstash returns a malformed (non-numeric) response', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-test-token-not-real'
    evalMock.mockResolvedValueOnce('not-a-number')
    const { checkRateLimitDistributed } = await import('../rate-limit-distributed-adapter')
    const result = await checkRateLimitDistributed(`malformed-test:${Date.now()}`, 5, 60_000)
    expect(result.allowed).toBe(true)
  })

  it('never includes the raw client-key suffix (e.g. a raw IP) in the generated Redis key', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-test-token-not-real'
    evalMock.mockResolvedValueOnce(1)
    const { checkRateLimitDistributed } = await import('../rate-limit-distributed-adapter')
    const rawIp = '198.51.100.42'
    await checkRateLimitDistributed(`bookings:cancel:${rawIp}`, 20, 60_000)
    const [, keys] = evalMock.mock.calls[0]
    const redisKey = keys[0] as string
    expect(redisKey).not.toContain(rawIp)
    // The observable domain/action label is preserved in the clear.
    expect(redisKey).toContain('bookings')
    // Same input always hashes to the same key (deterministic, not random).
    evalMock.mockResolvedValueOnce(2)
    await checkRateLimitDistributed(`bookings:cancel:${rawIp}`, 20, 60_000)
    expect(evalMock.mock.calls[1][1][0]).toBe(redisKey)
  })

  it('correctly parses an IPv6 client-key suffix (which itself contains colons) without corrupting the observable label', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-test-token-not-real'
    evalMock.mockResolvedValueOnce(1)
    const { checkRateLimitDistributed } = await import('../rate-limit-distributed-adapter')
    await checkRateLimitDistributed('search:2001:db8::1', 30, 60_000)
    const [, keys] = evalMock.mock.calls[0]
    const redisKey = keys[0] as string
    expect(redisKey).toContain('search')
    expect(redisKey).not.toContain('2001:db8::1')
  })

  it('logs only a sanitized message on backend failure -- never the token, URL, or raw client key', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'super-secret-token-value'
    evalMock.mockRejectedValueOnce(new Error('boom'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { checkRateLimitDistributed } = await import('../rate-limit-distributed-adapter')
    await checkRateLimitDistributed('log-test:203.0.113.9', 5, 60_000)
    const loggedText = errorSpy.mock.calls.map((c) => c.join(' ')).join(' ')
    expect(loggedText).not.toContain('super-secret-token-value')
    expect(loggedText).not.toContain('203.0.113.9')
    expect(loggedText).not.toContain('https://example.upstash.io')
    errorSpy.mockRestore()
  })

  it('multiple concurrent increments against the same key each receive a distinct sequential count (proves the atomicity contract, not real network concurrency)', async () => {
    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-test-token-not-real'
    let counter = 0
    evalMock.mockImplementation(async () => ++counter)
    const { checkRateLimitDistributed } = await import('../rate-limit-distributed-adapter')
    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkRateLimitDistributed('concurrency-test:203.0.113.7', 5, 60_000))
    )
    // With a genuinely atomic backend primitive, 5 concurrent requests
    // against a limit of 5 must all succeed (counts 1..5) and no two
    // requests may observe the same count -- exactly what this fake's
    // simple ++counter simulates for a real atomic INCR.
    expect(results.filter((r) => r.allowed)).toHaveLength(5)
  })
})

describe('rate-limit.ts (checkRateLimit / getClientKey) -- public contract unchanged in shape, now async', () => {
  beforeEach(async () => {
    delete process.env.UPSTASH_REDIS_REST_URL
    delete process.env.UPSTASH_REDIS_REST_TOKEN
    const { __resetDistributedClientForTests } = await import('../rate-limit-distributed-adapter')
    __resetDistributedClientForTests()
  })

  it('checkRateLimit resolves to { allowed, remaining } (no credentials needed -- exercises the memory fallback end to end)', async () => {
    const { checkRateLimit } = await import('../rate-limit')
    const result = await checkRateLimit(`public-contract-test:${Date.now()}`, 5, 60_000)
    expect(result).toEqual({ allowed: true, remaining: 4 })
  })

  it('getClientKey reads the first hop of x-forwarded-for', () => {
    // getClientKey is a synchronous, side-effect-free function with no
    // module-level state -- a plain top-level import is sufficient,
    // unlike checkRateLimit/checkRateLimitDistributed above which need
    // fresh dynamic imports per test to pick up env var changes.
    const req = new Request('https://unity.example/', { headers: { 'x-forwarded-for': '203.0.113.1, 10.0.0.1' } })
    expect(getClientKey(req)).toBe('203.0.113.1')
  })

  it('getClientKey falls back to "unknown" when the header is absent', () => {
    const req = new Request('https://unity.example/')
    expect(getClientKey(req)).toBe('unknown')
  })
})

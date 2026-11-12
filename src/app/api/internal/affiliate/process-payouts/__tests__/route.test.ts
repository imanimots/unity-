import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { GET } from '../route'

/**
 * E30: before this phase, an unset PAYMENT_PROVIDER in production meant
 * this scheduled cron sweep silently called MockProvider, marking real
 * affiliate commissions "paid" with zero money ever moving. The new
 * provider permission/capability gate runs BEFORE this route ever
 * creates its service-role client or queries a single candidate row --
 * proven here by never mocking supabase-js at all: if the gate did not
 * short-circuit first, these tests would fail for an entirely different
 * reason (a real network call attempt), not pass for the right one.
 *
 * vi.stubEnv/unstubAllEnvs matches this codebase's own established
 * convention for this kind of test -- see src/lib/checkout/__tests__/
 * test-scenario.test.ts.
 */
process.env.INTERNAL_CRON_SECRET = 'test-internal-cron-secret'
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key'

beforeEach(() => {
  vi.unstubAllEnvs()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

function authorizedRequest(): NextRequest {
  return new NextRequest('https://unity.test/api/internal/affiliate/process-payouts', {
    method: 'GET',
    headers: { authorization: 'Bearer test-internal-cron-secret' },
  })
}

describe('GET /api/internal/affiliate/process-payouts -- E30: provider permission/capability gate runs before any DB mutation', () => {
  it('production with PAYMENT_PROVIDER absent rejects with 503 before any candidate is queried or marked processing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', undefined)

    const response = await GET(authorizedRequest())

    expect(response.status).toBe(503)
    const json = await response.json()
    expect(json).toMatchObject({ considered: 0, paid: 0, failed: 0 })
  })

  it('production with PAYMENT_PROVIDER=mock also rejects with 503', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', 'mock')

    const response = await GET(authorizedRequest())

    expect(response.status).toBe(503)
  })

  it('production with PAYMENT_PROVIDER=peach also rejects with 503 while PEACH_PAYOUTS_EXECUTION_ENABLED is unset -- E33 added a SEPARATE, independently-defaulting-false execution gate that must reject before even the provider/capability check runs', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', 'peach')

    const response = await GET(authorizedRequest())

    expect(response.status).toBe(503)
    const json = await response.json()
    expect(json).toMatchObject({ considered: 0, paid: 0, failed: 0 })
  })

  it('E33: PAYMENT_PROVIDER=peach with PEACH_PAYOUTS_EXECUTION_ENABLED=true but no Peach Payouts credentials still rejects with 503, never proceeding to query a single candidate', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', 'peach')
    vi.stubEnv('PEACH_PAYOUTS_EXECUTION_ENABLED', 'true')
    vi.stubEnv('PEACH_PAYOUTS_CLIENT_ID', undefined)
    vi.stubEnv('PEACH_PAYOUTS_CLIENT_SECRET', undefined)
    vi.stubEnv('PEACH_PAYOUTS_MERCHANT_ID', undefined)

    const response = await GET(authorizedRequest())

    expect(response.status).toBe(503)
  })

  it('E33: PEACH_PAYOUTS_EXECUTION_ENABLED set to any value other than the exact string "true" still fails closed', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', 'peach')
    vi.stubEnv('PEACH_PAYOUTS_EXECUTION_ENABLED', 'TRUE')

    const response = await GET(authorizedRequest())

    expect(response.status).toBe(503)
  })
})

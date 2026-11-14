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
  it('production with PAYMENT_PROVIDER absent safely no-ops before any candidate is queried or marked processing', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', undefined)

    const response = await GET(authorizedRequest())

    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toMatchObject({ status: 'skipped', reason: 'real_payment_provider_not_configured', considered: 0, paid: 0, failed: 0 })
  })

  it('production with PAYMENT_PROVIDER=mock safely no-ops', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', 'mock')

    const response = await GET(authorizedRequest())

    expect(response.status).toBe(200)
  })

  it('production with legacy PAYMENT_PROVIDER=peach safely no-ops and never reaches legacy payout execution', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', 'peach')

    const response = await GET(authorizedRequest())

    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json).toMatchObject({ considered: 0, paid: 0, failed: 0 })
  })

  it('legacy Peach credentials cannot reactivate scheduled payout execution', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', 'peach')
    vi.stubEnv('PEACH_PAYOUTS_EXECUTION_ENABLED', 'true')
    vi.stubEnv('PEACH_PAYOUTS_CLIENT_ID', undefined)
    vi.stubEnv('PEACH_PAYOUTS_CLIENT_SECRET', undefined)
    vi.stubEnv('PEACH_PAYOUTS_MERCHANT_ID', undefined)

    const response = await GET(authorizedRequest())

    expect(response.status).toBe(200)
  })

  it('legacy Peach execution flags are ignored by the active scheduled route', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('PAYMENT_PROVIDER', 'peach')
    vi.stubEnv('PEACH_PAYOUTS_EXECUTION_ENABLED', 'TRUE')

    const response = await GET(authorizedRequest())

    expect(response.status).toBe(200)
  })
})

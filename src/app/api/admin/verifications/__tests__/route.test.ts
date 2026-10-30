import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const requireAdminForRoute = vi.fn()
const getAdminServiceClient = vi.fn()
vi.mock('@/lib/admin/route-helpers', () => ({
  requireAdminForRoute: (...args: unknown[]) => requireAdminForRoute(...args),
  getAdminServiceClient: (...args: unknown[]) => getAdminServiceClient(...args),
  isValidUuid: (v: string) => /^[0-9a-f-]{36}$/i.test(v),
}))

const { GET } = await import('../route')

function fakeVerificationsAdmin(rows: Record<string, unknown>[], eqCalls: unknown[][] = []) {
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: (...args: unknown[]) => {
      eqCalls.push(args)
      return obj
    },
    gte: () => obj,
    lte: () => obj,
    order: () => obj,
    limit: () => obj,
    then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => void) => resolve({ data: rows, error: null }),
  }
  return { from: () => obj }
}

function call() {
  return GET(new NextRequest('http://localhost/api/admin/verifications'))
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: 'admin', profile: {} } })
  getAdminServiceClient.mockReset()
})

describe('GET /api/admin/verifications — D3-F deliberately all-system KYC review queue (category: ADMIN-CONTROL-CENTRE-BATCH-D3-F)', () => {
  it('1. never filters identity_verifications or the embedded profile by data_classification -- an admin must action every pending submission regardless of classification, including test/QA accounts', async () => {
    const eqCalls: unknown[][] = []
    getAdminServiceClient.mockResolvedValue(fakeVerificationsAdmin([], eqCalls))
    await call()
    expect(eqCalls.some((c) => c[0] === 'data_classification')).toBe(false)
  })

  it('2. a test-classified submitter\'s row is still returned -- the queue is deliberately not Real-Data-scoped', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeVerificationsAdmin([
        {
          user_id: 'u1', status: 'pending', country_of_residence: 'ZA', submitted_at: '2026-01-01', review_count: 0, created_at: '2026-01-01',
          profiles: { full_name: 'QA Tester', role: 'renter', unity_score: 0, created_at: '2026-01-01', country_id: 'ZA' },
        },
      ])
    )
    const res = await call()
    const body = await res.json()
    expect(body.verifications).toHaveLength(1)
    expect(body.verifications[0].userId).toBe('u1')
  })

  it('3. admin authorization is required before any query runs', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(getAdminServiceClient).not.toHaveBeenCalled()
  })
})

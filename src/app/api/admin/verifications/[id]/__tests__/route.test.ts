import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const requireAdminForRoute = vi.fn()
const getAdminServiceClient = vi.fn()
vi.mock('@/lib/admin/route-helpers', () => ({
  requireAdminForRoute: (...args: unknown[]) => requireAdminForRoute(...args),
  getAdminServiceClient: (...args: unknown[]) => getAdminServiceClient(...args),
  isValidUuid: () => true,
}))
vi.mock('@/lib/identity-verification/document-access', () => ({
  listCurrentIdentityDocuments: vi.fn().mockResolvedValue([]),
}))

const { GET } = await import('../route')

function fakeDetailAdmin(profileRow: Record<string, unknown> | null) {
  const profileQuery: Record<string, unknown> = {}
  for (const m of ['select', 'eq']) profileQuery[m] = () => profileQuery
  profileQuery.maybeSingle = () => Promise.resolve({ data: profileRow, error: null })

  const empty: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order']) empty[m] = () => empty
  empty.maybeSingle = () => Promise.resolve({ data: null, error: null })
  empty.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null })

  return {
    from: (table: string) => (table === 'profiles' ? profileQuery : empty),
  }
}

function call(id = '11111111-1111-1111-1111-111111111111') {
  return GET(new NextRequest(`http://localhost/api/admin/verifications/${id}`), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: 'admin', profile: {} } })
  getAdminServiceClient.mockReset()
})

describe('GET /api/admin/verifications/[id] — D3-F deliberately all-system KYC review detail (category: ADMIN-CONTROL-CENTRE-BATCH-D3-F)', () => {
  it('1. a test-classified user\'s own verification detail still resolves -- the review detail is deliberately not Real-Data-scoped', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeDetailAdmin({ id: 'u1', full_name: 'QA Tester', role: 'renter', kyc_status: 'pending', unity_score: 0, created_at: '2026-01-01', country_id: 'ZA', data_classification: 'test' })
    )
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.id).toBe('u1')
  })

  it('2. admin authorization is required before any query runs', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(getAdminServiceClient).not.toHaveBeenCalled()
  })

  it('3. a missing profile returns 404', async () => {
    getAdminServiceClient.mockResolvedValue(fakeDetailAdmin(null))
    const res = await call()
    expect(res.status).toBe(404)
  })
})

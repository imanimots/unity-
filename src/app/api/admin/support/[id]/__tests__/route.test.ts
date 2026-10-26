import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const requireAdminForRoute = vi.fn()
const getAdminServiceClient = vi.fn()
vi.mock('@/lib/admin/route-helpers', () => ({
  requireAdminForRoute: (...args: unknown[]) => requireAdminForRoute(...args),
  getAdminServiceClient: (...args: unknown[]) => getAdminServiceClient(...args),
  isValidUuid: (value: string) => /^[0-9a-f-]{36}$/i.test(value),
}))

const getAdminSupportCaseDetail = vi.fn()
vi.mock('@/lib/admin/support-service', () => ({
  getAdminSupportCaseDetail: (...args: unknown[]) => getAdminSupportCaseDetail(...args),
}))

const { GET } = await import('../route')

const ADMIN_ID = '99999999-9999-9999-9999-999999999999'
const CASE_ID = '22222222-2222-2222-2222-222222222222'

function call(id = CASE_ID) {
  return GET(new NextRequest(`http://localhost/api/admin/support/${id}`), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  getAdminServiceClient.mockReset().mockResolvedValue({})
  getAdminSupportCaseDetail.mockReset()
})

describe('GET /api/admin/support/[id] (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — detail + authorization (A)', () => {
  it('1. an invalid case id is rejected before any admin check', async () => {
    const res = await call('not-a-uuid')
    expect(res.status).toBe(400)
    expect(requireAdminForRoute).not.toHaveBeenCalled()
  })

  it('2. a non-admin caller is rejected -- the case is never fetched', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(getAdminSupportCaseDetail).not.toHaveBeenCalled()
  })

  it('3. a nonexistent case returns 404, not a 500', async () => {
    getAdminSupportCaseDetail.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(404)
  })

  it('4. a real case returns the full workspace shape', async () => {
    getAdminSupportCaseDetail.mockResolvedValue({ case: { id: CASE_ID }, customerName: null, merchantName: null, assignedAdminName: null, notes: [], history: [] })
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.case.id).toBe(CASE_ID)
  })
})

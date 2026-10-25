import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const requireAdminForRoute = vi.fn()
const getAdminServiceClient = vi.fn()
vi.mock('@/lib/admin/route-helpers', () => ({
  requireAdminForRoute: (...args: unknown[]) => requireAdminForRoute(...args),
  getAdminServiceClient: (...args: unknown[]) => getAdminServiceClient(...args),
}))

const listAdminMerchants = vi.fn()
vi.mock('@/lib/admin/merchants-service', () => ({
  listAdminMerchants: (...args: unknown[]) => listAdminMerchants(...args),
}))

const { GET } = await import('../route')

const ADMIN_ID = '99999999-9999-9999-9999-999999999999'

function call(url = 'http://localhost/api/admin/merchants') {
  return GET(new NextRequest(url))
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  getAdminServiceClient.mockReset().mockResolvedValue({})
  listAdminMerchants.mockReset().mockResolvedValue([])
})

describe('GET /api/admin/merchants (category: ADMIN-CONTROL-CENTRE-BATCH-A1)', () => {
  it('1. a non-admin caller is rejected -- the merchant list service is never called', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(listAdminMerchants).not.toHaveBeenCalled()
  })

  it('2. query params are forwarded to the service as search/kycStatus/accountStatus', async () => {
    await call('http://localhost/api/admin/merchants?search=jane&kyc_status=approved&account_status=active')
    expect(listAdminMerchants).toHaveBeenCalledWith(expect.anything(), { search: 'jane', kycStatus: 'approved', accountStatus: 'active' })
  })

  it('3. a service error returns 500, not a crash', async () => {
    listAdminMerchants.mockRejectedValue(new Error('db down'))
    const res = await call()
    expect(res.status).toBe(500)
  })

  it('4. storage not configured returns 503', async () => {
    getAdminServiceClient.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(503)
  })
})

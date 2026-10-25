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

const getAdminAuthInfo = vi.fn()
vi.mock('@/lib/supabase/admin-auth-info', () => ({
  getAdminAuthInfo: (...args: unknown[]) => getAdminAuthInfo(...args),
}))

const { GET } = await import('../route')

const ADMIN_ID = '99999999-9999-9999-9999-999999999999'
const TARGET_ID = '11111111-1111-1111-1111-111111111111'

function call(id = TARGET_ID) {
  return GET(new NextRequest(`http://localhost/api/admin/users/${id}/auth-info`), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  getAdminServiceClient.mockReset().mockResolvedValue({})
  getAdminAuthInfo.mockReset()
})

describe('GET /api/admin/users/[id]/auth-info (category: ADMIN-CONTROL-CENTRE-BATCH-A1)', () => {
  it('1. an invalid target id is rejected before any admin check', async () => {
    const res = await call('not-a-uuid')
    expect(res.status).toBe(400)
    expect(requireAdminForRoute).not.toHaveBeenCalled()
  })

  it('2. a non-admin caller is rejected -- auth info is never fetched', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(getAdminAuthInfo).not.toHaveBeenCalled()
  })

  it('3. a real auth user is returned as-is', async () => {
    getAdminAuthInfo.mockResolvedValue({ authUserExists: true, email: 'a@b.com' })
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.authUserExists).toBe(true)
  })

  it('4. no matching auth user degrades to authUserExists:false rather than a 500', async () => {
    getAdminAuthInfo.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ authUserExists: false })
  })

  it('5. an unexpected error returns 500, never leaking the service-role client or raw error', async () => {
    getAdminAuthInfo.mockRejectedValue(new Error('internal'))
    const res = await call()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('service')
  })

  it('6. storage not configured returns 503, not a crash', async () => {
    getAdminServiceClient.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(503)
  })
})

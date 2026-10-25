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

const getAdminAuthInfoRespectingErasure = vi.fn()
vi.mock('@/lib/supabase/admin-auth-info', () => ({
  getAdminAuthInfoRespectingErasure: (...args: unknown[]) => getAdminAuthInfoRespectingErasure(...args),
}))

const { GET } = await import('../route')

const ADMIN_ID = '99999999-9999-9999-9999-999999999999'
const TARGET_ID = '11111111-1111-1111-1111-111111111111'

/** account_status is read via `.from('profiles').select('account_status').eq('id', id).maybeSingle()`. */
function fakeAdminClient(accountStatus: string | null, profileError: unknown = null) {
  return {
    from: (table: string) => {
      if (table !== 'profiles') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: accountStatus === null ? null : { account_status: accountStatus }, error: profileError }),
          }),
        }),
      }
    },
  }
}

function call(id = TARGET_ID) {
  return GET(new NextRequest(`http://localhost/api/admin/users/${id}/auth-info`), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  getAdminServiceClient.mockReset().mockResolvedValue(fakeAdminClient('active'))
  getAdminAuthInfoRespectingErasure.mockReset()
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
    expect(getAdminAuthInfoRespectingErasure).not.toHaveBeenCalled()
  })

  it('3. a real auth user is returned as-is for an active (non-erased) account', async () => {
    getAdminAuthInfoRespectingErasure.mockResolvedValue({ authUserExists: true, erased: false, email: 'a@b.com' })
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.authUserExists).toBe(true)
    expect(getAdminAuthInfoRespectingErasure).toHaveBeenCalledWith(expect.anything(), TARGET_ID, false)
  })

  it('4. no matching auth user degrades to authUserExists:false rather than a 500', async () => {
    getAdminAuthInfoRespectingErasure.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ authUserExists: false })
  })

  it('5. an unexpected error returns 500, never leaking the service-role client or raw error', async () => {
    getAdminAuthInfoRespectingErasure.mockRejectedValue(new Error('internal'))
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

/**
 * ADMIN-CONTROL-CENTRE-BATCH-A1-P1-REMEDIATION regression suite. These
 * prove the ROUTE's own responsibility: looking up account_status BEFORE
 * calling the auth-info function, and passing the correct isErased flag
 * -- independent of (in addition to) the library-level guarantee already
 * tested in src/lib/supabase/__tests__/admin-auth-info.test.ts.
 */
describe('GET /api/admin/users/[id]/auth-info — erasure gating (category: ADMIN-CONTROL-CENTRE-BATCH-A1-P1-REMEDIATION)', () => {
  it("1. ERASED CUSTOMER: account_status='erased' resolves isErased=true before the auth-info call", async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdminClient('erased'))
    getAdminAuthInfoRespectingErasure.mockResolvedValue({ authUserExists: true, erased: true })
    const res = await call()
    expect(res.status).toBe(200)
    expect(getAdminAuthInfoRespectingErasure).toHaveBeenCalledWith(expect.anything(), TARGET_ID, true)
  })

  it('2. ERASED MERCHANT: the route has no merchant/customer branch at all -- the same gating applies regardless of which page called it, since /admin/merchants/[id] hits this exact same route', async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdminClient('erased'))
    getAdminAuthInfoRespectingErasure.mockResolvedValue({ authUserExists: true, erased: true })
    const res = await call()
    const body = await res.json()
    expect(body).not.toHaveProperty('email')
    expect(body).not.toHaveProperty('phone')
  })

  it('3. SERVER-SIDE GUARANTEE: even if the (mocked) auth-info function were misconfigured to return PII, the route serializes exactly what it returns -- proving the route itself adds no separate leak path and the response body is the full contract surface', async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdminClient('erased'))
    getAdminAuthInfoRespectingErasure.mockResolvedValue({ authUserExists: true, erased: true })
    const res = await call()
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['authUserExists', 'erased'])
  })

  it('4. ACTIVE USER regression: a normal, non-erased account still resolves isErased=false', async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdminClient('active'))
    getAdminAuthInfoRespectingErasure.mockResolvedValue({ authUserExists: true, erased: false, email: 'a@b.com', phone: '+27820000000' })
    const res = await call()
    const body = await res.json()
    expect(body.email).toBe('a@b.com')
    expect(getAdminAuthInfoRespectingErasure).toHaveBeenCalledWith(expect.anything(), TARGET_ID, false)
  })

  it('5. a missing profile row (not found) safely defaults to isErased=false rather than throwing', async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdminClient(null))
    getAdminAuthInfoRespectingErasure.mockResolvedValue({ authUserExists: true, erased: false })
    const res = await call()
    expect(res.status).toBe(200)
    expect(getAdminAuthInfoRespectingErasure).toHaveBeenCalledWith(expect.anything(), TARGET_ID, false)
  })

  it('6. a profile lookup error returns 500 rather than silently treating the account as non-erased', async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdminClient('active', { message: 'db error' }))
    const res = await call()
    expect(res.status).toBe(500)
    expect(getAdminAuthInfoRespectingErasure).not.toHaveBeenCalled()
  })
})

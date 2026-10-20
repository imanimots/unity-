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

const runPostErasureCleanup = vi.fn()
vi.mock('@/lib/privacy/account-erasure', () => ({
  runPostErasureCleanup: (...args: unknown[]) => runPostErasureCleanup(...args),
}))

const { POST } = await import('../route')

const ADMIN_ID = '99999999-9999-9999-9999-999999999999'
const TARGET_ID = '11111111-1111-1111-1111-111111111111'

function fakeAdminClient(profile: { id: string; account_status: string } | null, profileError: unknown = null) {
  return {
    from: (table: string) => {
      if (table !== 'profiles') throw new Error(`unexpected table: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: profile, error: profileError }),
          }),
        }),
      }
    },
  }
}

function req() {
  return new NextRequest(`http://localhost/api/admin/users/${TARGET_ID}/retry-cleanup`, { method: 'POST' })
}
function call(id = TARGET_ID) {
  return POST(req(), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  getAdminServiceClient.mockReset().mockResolvedValue(fakeAdminClient({ id: TARGET_ID, account_status: 'erased' }))
  runPostErasureCleanup.mockReset().mockResolvedValue({ complete: true, pending: [] })
})

describe('POST /api/admin/users/[id]/retry-cleanup (category: P6-POPIA-ERASURE-AND-ANONYMIZATION-F1)', () => {
  it('1. an invalid target id is rejected before any admin check', async () => {
    const res = await call('not-a-uuid')
    expect(res.status).toBe(400)
    expect(requireAdminForRoute).not.toHaveBeenCalled()
  })

  it('2. a non-admin caller is rejected -- cleanup is never retried (retry authorization)', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(runPostErasureCleanup).not.toHaveBeenCalled()
  })

  it('3. a non-existent user returns 404 -- cleanup is never run', async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdminClient(null))
    const res = await call()
    expect(res.status).toBe(404)
    expect(runPostErasureCleanup).not.toHaveBeenCalled()
  })

  it('4. an account that was never erased is rejected -- retry can only operate on an already-erased account', async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdminClient({ id: TARGET_ID, account_status: 'active' }))
    const res = await call()
    expect(res.status).toBe(409)
    expect(runPostErasureCleanup).not.toHaveBeenCalled()
  })

  it('5. a restricted/suspended (but not erased) account is also rejected', async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdminClient({ id: TARGET_ID, account_status: 'suspended' }))
    const res = await call()
    expect(res.status).toBe(409)
    expect(runPostErasureCleanup).not.toHaveBeenCalled()
  })

  it('6. an erased account triggers a cleanup retry with the server-derived target id only', async () => {
    const admin = fakeAdminClient({ id: TARGET_ID, account_status: 'erased' })
    getAdminServiceClient.mockResolvedValue(admin)
    const res = await call()
    expect(res.status).toBe(200)
    expect(runPostErasureCleanup).toHaveBeenCalledWith(admin, TARGET_ID)
  })

  it('7. a still-pending retry result is reported accurately, not as complete', async () => {
    runPostErasureCleanup.mockResolvedValue({ complete: false, pending: ['auth_identity_ban'] })
    const res = await call()
    const body = await res.json()
    expect(body.cleanup_status).toBe('pending')
    expect(body.pending_cleanup).toEqual(['auth_identity_ban'])
  })

  it('8. a fully resolved retry reports complete with no pending_cleanup field', async () => {
    const res = await call()
    const body = await res.json()
    expect(body).toEqual({ cleanup_status: 'complete' })
  })

  it('9. a profile lookup failure returns a safe generic 500, never a raw db error', async () => {
    getAdminServiceClient.mockResolvedValue(fakeAdminClient(null, { message: 'relation "profiles" does not exist' }))
    const res = await call()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toMatch(/relation|profiles/)
  })

  it('10. storage not configured returns 503', async () => {
    getAdminServiceClient.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(503)
  })
})

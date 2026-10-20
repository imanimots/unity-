import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

const getAdminServiceClient = vi.fn()
vi.mock('@/lib/admin/route-helpers', () => ({
  getAdminServiceClient: (...args: unknown[]) => getAdminServiceClient(...args),
}))

const eraseAccount = vi.fn()
const runPostErasureCleanup = vi.fn()
vi.mock('@/lib/privacy/account-erasure', () => ({
  eraseAccount: (...args: unknown[]) => eraseAccount(...args),
  runPostErasureCleanup: (...args: unknown[]) => runPostErasureCleanup(...args),
  parseEraseAccountResult: (data: unknown) => {
    const row = data as { blocked?: boolean; blocked_categories?: string[]; already_erased?: boolean } | null
    if (row?.blocked) return { blocked: true, blockedCategories: row.blocked_categories ?? [] }
    return { blocked: false, alreadyErased: row?.already_erased ?? false }
  },
  describeBlockedCategories: (categories: string[]) =>
    categories.map((c) => (c === 'active_booking' ? 'an active or pending rental booking' : 'an unresolved obligation')),
  mapAccountErasureRpcError: (message: string | undefined) => {
    if (message?.includes('user not found')) return { status: 404, error: 'User not found.' }
    return { status: 500, error: 'Could not complete this request — please try again' }
  },
}))

const { POST } = await import('../route')

const USER_ID = '11111111-1111-1111-1111-111111111111'
const FAKE_ADMIN_CLIENT = { marker: 'admin-client' }

let ipCounter = 0
function req(body: unknown) {
  ipCounter += 1
  return new NextRequest('http://localhost/api/account/erase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.2.${ipCounter}` },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: USER_ID, profile: {} })
  getAdminServiceClient.mockReset().mockResolvedValue(FAKE_ADMIN_CLIENT)
  eraseAccount.mockReset().mockResolvedValue({ data: { blocked: false, already_erased: false }, error: null })
  runPostErasureCleanup.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/account/erase (category: P6-POPIA-ERASURE-AND-ANONYMIZATION-I)', () => {
  it('1. an anonymous caller is rejected -- erase_account is never called', async () => {
    getRequestProfile.mockResolvedValue(null)
    const res = await POST(req({}))
    expect(res.status).toBe(401)
    expect(eraseAccount).not.toHaveBeenCalled()
  })

  it('2. always targets the session user -- any user_id in the body is ignored, never forwarded', async () => {
    const res = await POST(req({ user_id: 'some-other-user-id' }))
    expect(res.status).toBe(200)
    expect(eraseAccount).toHaveBeenCalledWith(FAKE_ADMIN_CLIENT, USER_ID, USER_ID, 'self_service', undefined)
  })

  it('3. a successful erasure runs post-erasure cleanup for the session user', async () => {
    await POST(req({}))
    expect(runPostErasureCleanup).toHaveBeenCalledWith(FAKE_ADMIN_CLIENT, USER_ID)
  })

  it('4. a blocked result returns 409 with safe, generic reasons -- cleanup is never run', async () => {
    eraseAccount.mockResolvedValue({ data: { blocked: true, blocked_categories: ['active_booking'] }, error: null })
    const res = await POST(req({}))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.status).toBe('blocked')
    expect(body.reasons).toEqual(['an active or pending rental booking'])
    expect(runPostErasureCleanup).not.toHaveBeenCalled()
  })

  it('5. an RPC error never leaks the raw Postgres message', async () => {
    eraseAccount.mockResolvedValue({ data: null, error: { message: 'relation "foo" does not exist' } })
    const res = await POST(req({}))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toMatch(/relation|foo/)
  })

  it('6. an idempotent replay of an already-erased account still succeeds and re-runs cleanup', async () => {
    eraseAccount.mockResolvedValue({ data: { blocked: false, already_erased: true }, error: null })
    const res = await POST(req({ idempotency_key: 'retry-key-00000001' }))
    expect(res.status).toBe(200)
    expect(runPostErasureCleanup).toHaveBeenCalledWith(FAKE_ADMIN_CLIENT, USER_ID)
  })

  it('7. a malformed idempotency key is rejected by schema validation before calling the RPC', async () => {
    const res = await POST(req({ idempotency_key: 'short' }))
    expect(res.status).toBe(400)
    expect(eraseAccount).not.toHaveBeenCalled()
  })

  it('8. storage not configured returns 503', async () => {
    getAdminServiceClient.mockResolvedValue(null)
    const res = await POST(req({}))
    expect(res.status).toBe(503)
  })
})

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

const addAdminNote = vi.fn()
vi.mock('@/lib/admin/users-service', () => ({
  addAdminNote: (...args: unknown[]) => addAdminNote(...args),
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
    categories.map((c) => (c === 'open_dispute' ? 'an unresolved dispute' : 'an unresolved obligation')),
  mapAccountErasureRpcError: (message: string | undefined) => {
    if (message?.includes('use the self-service erasure flow')) return { status: 403, error: 'Use the account privacy page to erase your own account.' }
    return { status: 500, error: 'Could not complete this request — please try again' }
  },
}))

const { POST } = await import('../route')

const ADMIN_ID = '99999999-9999-9999-9999-999999999999'
const TARGET_ID = '11111111-1111-1111-1111-111111111111'
const FAKE_ADMIN_CLIENT = { marker: 'admin-client' }

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/admin/users/${TARGET_ID}/erase`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function call(body: unknown, id = TARGET_ID) {
  return POST(req(body), { params: Promise.resolve({ id }) })
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  getAdminServiceClient.mockReset().mockResolvedValue(FAKE_ADMIN_CLIENT)
  eraseAccount.mockReset().mockResolvedValue({ data: { blocked: false, already_erased: false }, error: null })
  runPostErasureCleanup.mockReset().mockResolvedValue(undefined)
  addAdminNote.mockReset().mockResolvedValue({ data: {}, error: null })
})

describe('POST /api/admin/users/[id]/erase (category: P6-POPIA-ERASURE-AND-ANONYMIZATION-I)', () => {
  it('1. an invalid target id is rejected before any admin check', async () => {
    const res = await call({}, 'not-a-uuid')
    expect(res.status).toBe(400)
    expect(requireAdminForRoute).not.toHaveBeenCalled()
  })

  it('2. a non-admin caller is rejected -- erase_account is never called', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call({})
    expect(res.status).toBe(401)
    expect(eraseAccount).not.toHaveBeenCalled()
  })

  it('3. a successful admin-assisted erasure calls erase_account with request_source "admin" and the admin as actor', async () => {
    const res = await call({})
    expect(res.status).toBe(200)
    expect(eraseAccount).toHaveBeenCalledWith(FAKE_ADMIN_CLIENT, TARGET_ID, ADMIN_ID, 'admin', undefined)
    expect(runPostErasureCleanup).toHaveBeenCalledWith(FAKE_ADMIN_CLIENT, TARGET_ID)
  })

  it('4. a blocked result returns 409 with safe, generic reasons -- cleanup is never run', async () => {
    eraseAccount.mockResolvedValue({ data: { blocked: true, blocked_categories: ['open_dispute'] }, error: null })
    const res = await call({})
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.reasons).toEqual(['an unresolved dispute'])
    expect(runPostErasureCleanup).not.toHaveBeenCalled()
  })

  it('5. an admin attempting to erase their own account via this route is rejected with a safe 403', async () => {
    eraseAccount.mockResolvedValue({ data: null, error: { message: 'use the self-service erasure flow for your own account' } })
    const res = await call({}, ADMIN_ID)
    expect(res.status).toBe(403)
  })

  it('6. an internal note is recorded via the existing admin_notes mechanism when provided', async () => {
    await call({ internal_note: 'Requested via support ticket #123' })
    expect(addAdminNote).toHaveBeenCalledWith(FAKE_ADMIN_CLIENT, 'user', TARGET_ID, ADMIN_ID, 'Requested via support ticket #123', undefined)
  })

  it('7. no internal note is recorded when none is provided', async () => {
    await call({})
    expect(addAdminNote).not.toHaveBeenCalled()
  })

  it('8. storage not configured returns 503', async () => {
    getAdminServiceClient.mockResolvedValue(null)
    const res = await call({})
    expect(res.status).toBe(503)
  })
})

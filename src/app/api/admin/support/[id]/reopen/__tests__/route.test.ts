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

const { POST } = await import('../route')

const ADMIN_ID = '99999999-9999-9999-9999-999999999999'
const CASE_ID = '22222222-2222-2222-2222-222222222222'

function postReq(body: unknown) {
  return POST(new NextRequest(`http://localhost/api/admin/support/${CASE_ID}/reopen`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: CASE_ID }) })
}

let rpcMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  rpcMock = vi.fn().mockResolvedValue({ data: { id: CASE_ID, status: 'open' }, error: null })
  getAdminServiceClient.mockReset().mockResolvedValue({ rpc: rpcMock })
})

describe('POST /api/admin/support/[id]/reopen (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — reopen (D)', () => {
  it('1. a non-admin caller is rejected', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await postReq({ reason: 'New information came in' })
    expect(res.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('2. a missing reason is rejected by validation -- reopen is always an explicit, justified operation (Part 7, Part 17)', async () => {
    const res = await postReq({})
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('3. closed -> open with a reason is accepted and forwarded to the RPC', async () => {
    const res = await postReq({ reason: 'New information came in' })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('reopen_support_case', expect.objectContaining({ p_admin_id: ADMIN_ID, p_case_id: CASE_ID, p_reason: 'New information came in' }))
  })

  it('4. reopening a case that is not resolved/closed maps the RPC rejection to 409 -- never a raw PATCH to an arbitrary status', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'only a resolved or closed case can be reopened' } })
    const res = await postReq({ reason: 'x' })
    expect(res.status).toBe(409)
  })
})

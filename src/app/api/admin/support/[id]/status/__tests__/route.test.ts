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
  return POST(new NextRequest(`http://localhost/api/admin/support/${CASE_ID}/status`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: CASE_ID }) })
}

let rpcMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  rpcMock = vi.fn().mockResolvedValue({ data: { id: CASE_ID, status: 'in_progress' }, error: null })
  getAdminServiceClient.mockReset().mockResolvedValue({ rpc: rpcMock })
})

describe('POST /api/admin/support/[id]/status (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — lifecycle (D)', () => {
  it('1. a non-admin caller is rejected', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await postReq({ target_status: 'in_progress' })
    expect(res.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('2. open -> in_progress is accepted and forwarded to the RPC', async () => {
    const res = await postReq({ target_status: 'in_progress' })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('update_support_case_status', expect.objectContaining({ p_target_status: 'in_progress' }))
  })

  it('3. in_progress -> waiting_on_user is accepted and forwarded to the RPC', async () => {
    const res = await postReq({ target_status: 'waiting_on_user' })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('update_support_case_status', expect.objectContaining({ p_target_status: 'waiting_on_user' }))
  })

  it('4. an invalid target_status (e.g. "escalated") is rejected by validation before the RPC is called -- those require the dedicated action', async () => {
    const res = await postReq({ target_status: 'escalated' })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('5. an unknown status value is rejected by validation', async () => {
    const res = await postReq({ target_status: 'not_a_real_status' })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('6. a transition the RPC itself rejects (case already escalated/resolved/closed) maps to 409, not 500', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'this case must be reopened before its status can change again' } })
    const res = await postReq({ target_status: 'open' })
    expect(res.status).toBe(409)
  })
})

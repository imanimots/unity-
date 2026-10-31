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
  return POST(new NextRequest(`http://localhost/api/admin/support/${CASE_ID}/escalate`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: CASE_ID }) })
}

let rpcMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  rpcMock = vi.fn().mockResolvedValue({ data: { id: CASE_ID, status: 'escalated' }, error: null })
  getAdminServiceClient.mockReset().mockResolvedValue({ rpc: rpcMock })
})

describe('POST /api/admin/support/[id]/escalate (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — escalation (D)', () => {
  it('1. a non-admin caller is rejected', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await postReq({ reason: 'Customer threatening legal action' })
    expect(res.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('2. a missing reason is rejected by validation before the RPC is called (Part 17 — reason required for escalation)', async () => {
    const res = await postReq({})
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('3. an empty-string reason is rejected by validation', async () => {
    const res = await postReq({ reason: '' })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('4. a valid reason escalates via the RPC', async () => {
    const res = await postReq({ reason: 'Customer threatening legal action' })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('escalate_support_case', expect.objectContaining({ p_admin_id: ADMIN_ID, p_case_id: CASE_ID, p_reason: 'Customer threatening legal action' }))
  })

  it('5. escalating an already-escalated/resolved/closed case maps the RPC rejection to 409', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'only an active, non-escalated case can be escalated' } })
    const res = await postReq({ reason: 'x' })
    expect(res.status).toBe(409)
  })

  it('6. E6: a spoofed admin identity field in the body is ignored -- attribution always comes from the authenticated session', async () => {
    const ATTACKER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const res = await postReq({ reason: 'Escalated', admin_id: ATTACKER_ID, adminId: ATTACKER_ID, p_admin_id: ATTACKER_ID })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('escalate_support_case', expect.objectContaining({ p_admin_id: ADMIN_ID }))
  })
})

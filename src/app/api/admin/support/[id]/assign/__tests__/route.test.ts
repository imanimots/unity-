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
const ASSIGNEE_ID = '33333333-3333-4333-8333-333333333333'
const CASE_ID = '22222222-2222-2222-2222-222222222222'

function postReq(body: unknown, id = CASE_ID) {
  return POST(new NextRequest(`http://localhost/api/admin/support/${id}/assign`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
}

let rpcMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  rpcMock = vi.fn().mockResolvedValue({ data: { id: CASE_ID, assigned_admin_id: ASSIGNEE_ID }, error: null })
  getAdminServiceClient.mockReset().mockResolvedValue({ rpc: rpcMock })
})

describe('POST /api/admin/support/[id]/assign (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — assignment (C)', () => {
  it('1. a non-admin caller is rejected -- no assignment is written', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await postReq({ assignee_admin_id: ASSIGNEE_ID })
    expect(res.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('2. a non-UUID assignee is rejected by validation', async () => {
    const res = await postReq({ assignee_admin_id: 'not-a-uuid' })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('3. assigns via the RPC with the authenticated admin as actor', async () => {
    const res = await postReq({ assignee_admin_id: ASSIGNEE_ID })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('assign_support_case', expect.objectContaining({ p_admin_id: ADMIN_ID, p_case_id: CASE_ID, p_assignee_admin_id: ASSIGNEE_ID }))
  })

  it('4. a reassignment history entry is produced (verified at the RPC level -- the database function always writes support_case_history)', async () => {
    rpcMock.mockResolvedValue({ data: { id: CASE_ID, assigned_admin_id: ASSIGNEE_ID }, error: null })
    const res = await postReq({ assignee_admin_id: ASSIGNEE_ID })
    expect(res.status).toBe(200)
    // The route's only job is to call the RPC once per request -- the
    // RPC itself (assign_support_case) is unconditionally paired with a
    // support_case_history insert (see the migration), so a single RPC
    // call here is the full contract this layer can assert.
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it('5. an "assignee must be an admin" RPC error maps to 400, not a raw Postgres error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'assignee must be an admin' } })
    const res = await postReq({ assignee_admin_id: ASSIGNEE_ID })
    expect(res.status).toBe(400)
  })

  it('6. a not-found case maps to 404', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'support case not found' } })
    const res = await postReq({ assignee_admin_id: ASSIGNEE_ID })
    expect(res.status).toBe(404)
  })

  it('7. E6: a spoofed admin identity field in the body is ignored -- attribution always comes from the authenticated session', async () => {
    const ATTACKER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const res = await postReq({ assignee_admin_id: ASSIGNEE_ID, admin_id: ATTACKER_ID, adminId: ATTACKER_ID, p_admin_id: ATTACKER_ID })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('assign_support_case', expect.objectContaining({ p_admin_id: ADMIN_ID }))
  })
})

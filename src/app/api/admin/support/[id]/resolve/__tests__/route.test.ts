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
  return POST(new NextRequest(`http://localhost/api/admin/support/${CASE_ID}/resolve`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: CASE_ID }) })
}

let rpcMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  rpcMock = vi.fn().mockResolvedValue({ data: { id: CASE_ID, status: 'resolved' }, error: null })
  getAdminServiceClient.mockReset().mockResolvedValue({ rpc: rpcMock })
})

describe('POST /api/admin/support/[id]/resolve (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — resolve (D)', () => {
  it('1. a non-admin caller is rejected', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await postReq({ resolution_summary: 'Refunded in full' })
    expect(res.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('2. a missing resolution_summary is rejected by validation (Part 17 — summary required)', async () => {
    const res = await postReq({})
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('3. a valid resolution resolves via the RPC', async () => {
    const res = await postReq({ resolution_summary: 'Refunded in full' })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('resolve_support_case', expect.objectContaining({ p_admin_id: ADMIN_ID, p_case_id: CASE_ID, p_resolution_summary: 'Refunded in full' }))
  })

  it('4. resolving a case in an invalid status maps the RPC rejection to 409', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'this case cannot be resolved from its current status' } })
    const res = await postReq({ resolution_summary: 'x' })
    expect(res.status).toBe(409)
  })
})

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
  parseListLimit: (raw: string | null) => (raw ? Number(raw) : undefined),
}))

const listAdminSupportCases = vi.fn()
vi.mock('@/lib/admin/support-service', () => ({
  listAdminSupportCases: (...args: unknown[]) => listAdminSupportCases(...args),
}))

const { GET, POST } = await import('../route')

const ADMIN_ID = '99999999-9999-9999-9999-999999999999'
const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'

function getReq(qs = '') {
  return GET(new NextRequest(`http://localhost/api/admin/support${qs}`))
}
function postReq(body: unknown) {
  return POST(new NextRequest('http://localhost/api/admin/support', { method: 'POST', body: JSON.stringify(body) }))
}

let rpcMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  rpcMock = vi.fn().mockResolvedValue({ data: { id: 'case-1', case_number: 'SUP-2026-000001', status: 'open' }, error: null })
  getAdminServiceClient.mockReset().mockResolvedValue({ rpc: rpcMock })
  listAdminSupportCases.mockReset().mockResolvedValue({ cases: [], total: 0 })
})

describe('GET /api/admin/support (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — authorization + list filters (J)', () => {
  it('1. a non-admin caller is rejected before the list is ever queried', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await getReq()
    expect(res.status).toBe(401)
    expect(listAdminSupportCases).not.toHaveBeenCalled()
  })

  it('2. an admin caller lists cases with server-side filters and pagination passed through', async () => {
    const res = await getReq('?status=open&priority=high&category=payment&offset=50&limit=25')
    expect(res.status).toBe(200)
    expect(listAdminSupportCases).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'open', priority: 'high', category: 'payment', offset: 50, limit: 25 })
    )
  })

  it('3. an invalid userId deep-link filter is rejected with 400', async () => {
    const res = await getReq('?userId=not-a-uuid')
    expect(res.status).toBe(400)
    expect(listAdminSupportCases).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/support (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — creation (B)', () => {
  it('4. a non-admin caller is rejected -- no case is created', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await postReq({ title: 'x', category: 'general_other', customer_id: CUSTOMER_ID })
    expect(res.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('5. a missing title is rejected by validation before the RPC is called', async () => {
    const res = await postReq({ title: '', category: 'general_other', customer_id: CUSTOMER_ID })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('6. an invalid category is rejected by validation before the RPC is called', async () => {
    const res = await postReq({ title: 'Help', category: 'not_a_real_category', customer_id: CUSTOMER_ID })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('7. missing both customer_id and merchant_id is rejected by validation', async () => {
    const res = await postReq({ title: 'Help', category: 'general_other' })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('8. linked_entity_type without linked_entity_id is rejected by validation', async () => {
    const res = await postReq({ title: 'Help', category: 'general_other', customer_id: CUSTOMER_ID, linked_entity_type: 'booking' })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('9. an invalid linked_entity_type is rejected by validation before the RPC is called', async () => {
    const res = await postReq({ title: 'Help', category: 'general_other', customer_id: CUSTOMER_ID, linked_entity_type: 'spaceship', linked_entity_id: CUSTOMER_ID })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('10. a valid request calls create_support_case with the authenticated admin as actor, never a client-supplied admin id', async () => {
    const res = await postReq({ title: 'Help', category: 'general_other', customer_id: CUSTOMER_ID })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('create_support_case', expect.objectContaining({ p_admin_id: ADMIN_ID, p_title: 'Help', p_category: 'general_other', p_customer_id: CUSTOMER_ID }))
  })

  it('11. an RPC error is mapped to a safe status/message, never the raw Postgres error', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'a support case requires at least one of customer_id or merchant_id' } })
    const res = await postReq({ title: 'Help', category: 'general_other', customer_id: CUSTOMER_ID })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).not.toContain('p_customer_id')
  })

  it('12. E6: a spoofed admin identity field anywhere in the request body is ignored -- attribution always comes from the authenticated session, never the client', async () => {
    const ATTACKER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const res = await postReq({ title: 'Help', category: 'general_other', customer_id: CUSTOMER_ID, admin_id: ATTACKER_ID, adminId: ATTACKER_ID, p_admin_id: ATTACKER_ID })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('create_support_case', expect.objectContaining({ p_admin_id: ADMIN_ID }))
  })
})

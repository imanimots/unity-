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
  return POST(new NextRequest(`http://localhost/api/admin/support/${CASE_ID}/notes`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id: CASE_ID }) })
}

let rpcMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  rpcMock = vi.fn().mockResolvedValue({ data: { id: 'note-1', case_id: CASE_ID }, error: null })
  getAdminServiceClient.mockReset().mockResolvedValue({ rpc: rpcMock })
})

describe('POST /api/admin/support/[id]/notes (category: ADMIN-CONTROL-CENTRE-BATCH-A2) — internal notes (E)', () => {
  it('1. a non-admin caller is rejected -- the note is never written', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await postReq({ note: 'Called customer back' })
    expect(res.status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('2. a blank note is rejected by validation before the RPC is called', async () => {
    const res = await postReq({ note: '' })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('3. an oversized note (>4000 chars) is rejected by validation', async () => {
    const res = await postReq({ note: 'a'.repeat(4001) })
    expect(res.status).toBe(400)
    expect(rpcMock).not.toHaveBeenCalled()
  })

  it('4. a valid note appends via add_support_case_note, never the generic add_admin_note RPC (Part 15 -- distinct concepts)', async () => {
    const res = await postReq({ note: 'Called customer back' })
    expect(res.status).toBe(200)
    expect(rpcMock).toHaveBeenCalledWith('add_support_case_note', expect.objectContaining({ p_admin_id: ADMIN_ID, p_case_id: CASE_ID, p_note: 'Called customer back' }))
  })

  it('5. there is no PATCH/DELETE export on this route module -- notes are append-only with no edit/delete route', async () => {
    const mod = await import('../route')
    expect((mod as Record<string, unknown>).PATCH).toBeUndefined()
    expect((mod as Record<string, unknown>).DELETE).toBeUndefined()
    expect((mod as Record<string, unknown>).PUT).toBeUndefined()
  })
})

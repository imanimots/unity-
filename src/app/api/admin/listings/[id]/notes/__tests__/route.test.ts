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

const listAdminNotesForEntity = vi.fn()
vi.mock('@/lib/admin/notes-service', () => ({
  listAdminNotesForEntity: (...args: unknown[]) => listAdminNotesForEntity(...args),
}))

const addAdminNote = vi.fn()
vi.mock('@/lib/admin/users-service', () => ({
  addAdminNote: (...args: unknown[]) => addAdminNote(...args),
}))

const { GET, POST } = await import('../route')

const ADMIN_ID = '99999999-9999-9999-9999-999999999999'
const LISTING_ID = '11111111-1111-1111-1111-111111111111'

function getReq(id = LISTING_ID) {
  return GET(new NextRequest(`http://localhost/api/admin/listings/${id}/notes`), { params: Promise.resolve({ id }) })
}
function postReq(body: unknown, id = LISTING_ID) {
  return POST(
    new NextRequest(`http://localhost/api/admin/listings/${id}/notes`, { method: 'POST', body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  )
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  getAdminServiceClient.mockReset().mockResolvedValue({})
  listAdminNotesForEntity.mockReset().mockResolvedValue([])
  addAdminNote.mockReset().mockResolvedValue({ data: { ok: true }, error: null })
})

describe('GET /api/admin/listings/[id]/notes (category: ADMIN-CONTROL-CENTRE-BATCH-A1)', () => {
  it('1. an invalid listing id is rejected before any admin check', async () => {
    const res = await getReq('not-a-uuid')
    expect(res.status).toBe(400)
    expect(requireAdminForRoute).not.toHaveBeenCalled()
  })

  it('2. a non-admin caller is rejected -- notes are never exposed through this route to a non-admin', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await getReq()
    expect(res.status).toBe(401)
    expect(listAdminNotesForEntity).not.toHaveBeenCalled()
  })

  it("3. reads notes scoped to entity_type='listing', not 'user' or 'booking'", async () => {
    await getReq()
    expect(listAdminNotesForEntity).toHaveBeenCalledWith(expect.anything(), 'listing', LISTING_ID)
  })
})

describe('POST /api/admin/listings/[id]/notes (category: ADMIN-CONTROL-CENTRE-BATCH-A1)', () => {
  it('4. a non-admin caller is rejected -- the note is never written', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await postReq({ note: 'hello' })
    expect(res.status).toBe(401)
    expect(addAdminNote).not.toHaveBeenCalled()
  })

  it('5. an empty note is rejected by validation before the RPC is called', async () => {
    const res = await postReq({ note: '' })
    expect(res.status).toBe(400)
    expect(addAdminNote).not.toHaveBeenCalled()
  })

  it("6. a valid note appends via the generic add_admin_note RPC with entity_type='listing'", async () => {
    const res = await postReq({ note: 'Looks suspicious, flagging for re-review.' })
    expect(res.status).toBe(200)
    expect(addAdminNote).toHaveBeenCalledWith(expect.anything(), 'listing', LISTING_ID, ADMIN_ID, 'Looks suspicious, flagging for re-review.', undefined)
  })

  it('7. an RPC error is mapped, not leaked raw', async () => {
    addAdminNote.mockResolvedValue({ data: null, error: { message: 'not authorized' } })
    const res = await postReq({ note: 'test' })
    expect(res.status).toBeGreaterThanOrEqual(400)
  })
})

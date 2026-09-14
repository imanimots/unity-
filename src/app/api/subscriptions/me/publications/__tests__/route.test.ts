import { describe, it, expect, vi, beforeEach } from 'vitest'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const getRequestProfile = vi.fn()
vi.mock('@/lib/supabase/require-admin', () => ({ getRequestProfile: (...args: unknown[]) => getRequestProfile(...args) }))

// ── Local, purpose-built fake for this route only. The shared
// fakeServiceRoleClient (src/app/api/__tests__/fake-service-role-client.ts)
// doesn't record .eq()/.in() call arguments, so it can't prove WHICH
// filters a query chain actually applied -- exactly what this fix needs
// proven (that the barter_skill_task_posts query really asks for
// direction='available', not just that some row comes back). This fake
// mocks the DATA LAYER only, same boundary the shared one documents for
// itself: it cannot simulate real Postgres row filtering, so exclusion
// of a Looking-For/inactive/test row is proven by asserting the exact
// filter chain the route constructs, not by the fake filtering rows
// itself -- a correctly-filtered live query could never return such a
// row in the first place. ──
function fakeAdmin(tableData: Record<string, Array<{ id: string; title: string; created_at: string }>>) {
  const calls: Record<string, Array<[string, unknown]>> = {}
  const from = vi.fn((table: string) => {
    calls[table] = []
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        calls[table].push([col, val])
        return chain
      },
      in: (col: string, vals: unknown) => {
        calls[table].push([col, vals])
        return chain
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
        Promise.resolve({ data: tableData[table] ?? [], error: null }).then(resolve, reject),
    }
    return chain
  })
  return { from, calls }
}

let nextAdmin: ReturnType<typeof fakeAdmin>
vi.mock('@/lib/admin/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/admin/route-helpers')>()
  return { ...actual, getAdminServiceClient: () => Promise.resolve(nextAdmin) }
})

const { GET } = await import('../route')

const USER_ID = '22222222-2222-2222-2222-222222222222'

const listingRow = { id: 'listing-1', title: 'A Listing', created_at: '2026-09-01T00:00:00Z' }
const skillTaskRow = { id: 'post-1', title: 'A Skill Post', created_at: '2026-09-02T00:00:00Z' }
const requestRowActive = { id: 'req-1', title: 'A Request', created_at: '2026-09-03T00:00:00Z' }
const requestRowOffers = { id: 'req-2', title: 'Another Request', created_at: '2026-09-04T00:00:00Z' }

beforeEach(() => {
  getRequestProfile.mockReset().mockResolvedValue({ userId: USER_ID, profile: {} })
  nextAdmin = fakeAdmin({})
})

describe('GET /api/subscriptions/me/publications (category: Active-Supply API-Fidelity Joint Fix, Defect 3)', () => {
  it('anonymous -> 401', async () => {
    getRequestProfile.mockResolvedValue(null)
    const res = await GET()
    expect(res.status).toBe(401)
  })

  it('A. an Available/active/non-test Skill/Task post appears', async () => {
    nextAdmin = fakeAdmin({ barter_skill_task_posts: [skillTaskRow] })
    const res = await GET()
    const body = await res.json()
    expect(body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityType: 'barter_skill_task_post', entityId: 'post-1' })])
    )
  })

  it('B/C/D/E. the barter_skill_task_posts query chain filters owner_id, direction=available, status=active, is_test=false -- structurally excluding Looking-For, offers_received, inactive, and test rows from ever matching (a real Postgres query using this exact chain can never return such a row)', async () => {
    await GET()
    expect(nextAdmin.calls['barter_skill_task_posts']).toEqual([
      ['owner_id', USER_ID],
      ['direction', 'available'],
      ['status', 'active'],
      ['is_test', false],
    ])
  })

  it('F. an active marketplace_request appears', async () => {
    nextAdmin = fakeAdmin({ marketplace_requests: [requestRowActive] })
    const res = await GET()
    const body = await res.json()
    expect(body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityType: 'marketplace_request', entityId: 'req-1' })])
    )
  })

  it('G. an offers_received marketplace_request appears', async () => {
    nextAdmin = fakeAdmin({ marketplace_requests: [requestRowOffers] })
    const res = await GET()
    const body = await res.json()
    expect(body.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ entityType: 'marketplace_request', entityId: 'req-2' })])
    )
  })

  it('marketplace_requests query chain unchanged -- requester_id, status IN (active, offers_received), is_test=false', async () => {
    await GET()
    expect(nextAdmin.calls['marketplace_requests']).toEqual([
      ['requester_id', USER_ID],
      ['status', ['active', 'offers_received']],
      ['is_test', false],
    ])
  })

  it('H. an active listing appears', async () => {
    nextAdmin = fakeAdmin({ listings: [listingRow] })
    const res = await GET()
    const body = await res.json()
    expect(body.items).toEqual(expect.arrayContaining([expect.objectContaining({ entityType: 'listing', entityId: 'listing-1' })]))
  })

  it('listings query chain unchanged -- merchant_id, status=active, is_test=false', async () => {
    await GET()
    expect(nextAdmin.calls['listings']).toEqual([
      ['merchant_id', USER_ID],
      ['status', 'active'],
      ['is_test', false],
    ])
  })

  it('I. entity types/mapping remain correct across all three sources combined', async () => {
    nextAdmin = fakeAdmin({
      listings: [listingRow],
      marketplace_requests: [requestRowActive],
      barter_skill_task_posts: [skillTaskRow],
    })
    const res = await GET()
    const body = await res.json()
    const byType = Object.fromEntries(body.items.map((i: { entityType: string; entityId: string }) => [i.entityType, i.entityId]))
    expect(byType).toEqual({
      listing: 'listing-1',
      marketplace_request: 'req-1',
      barter_skill_task_post: 'post-1',
    })
  })

  it('J. response shape is items[] only -- no count/remaining/limit field of any kind', async () => {
    nextAdmin = fakeAdmin({ listings: [listingRow] })
    const res = await GET()
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['items'])
  })

  it('subscription storage not configured -> 503', async () => {
    // getAdminServiceClient() resolving to null/undefined is the existing
    // "not configured" contract this route already handles -- unchanged.
    nextAdmin = undefined as unknown as ReturnType<typeof fakeAdmin>
    const res = await GET()
    expect(res.status).toBe(503)
  })
})

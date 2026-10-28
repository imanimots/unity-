import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://fake-project.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'fake-service-role-key'

const requireAdminForRoute = vi.fn()
const getAdminServiceClient = vi.fn()
vi.mock('@/lib/admin/route-helpers', () => ({
  requireAdminForRoute: (...args: unknown[]) => requireAdminForRoute(...args),
  getAdminServiceClient: (...args: unknown[]) => getAdminServiceClient(...args),
}))

const { GET } = await import('../route')

/** D3-D: a flexible per-table mock mirroring disputes-service.test.ts's fakeTableData, needed because review_reports resolves its target review through two hops (reply -> review) that a single embedded join cannot express. */
function fakeTableData(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from: (table: string) => {
      const rows = tables[table] ?? []
      let inFilters: Record<string, unknown[]> = {}
      const obj: Record<string, unknown> = {
        select: () => obj,
        eq: () => obj,
        in: (col: string, vals: unknown[]) => {
          inFilters = { ...inFilters, [col]: vals }
          return obj
        },
        order: () => obj,
        then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => void) => {
          const matched = rows.filter((r) => Object.entries(inFilters).every(([k, v]) => v.includes(r[k])))
          resolve({ data: matched, error: null })
        },
      }
      return obj
    },
  }
}

function call() {
  return GET(new NextRequest('http://localhost/api/admin/reviews'))
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: 'admin', profile: {} } })
  getAdminServiceClient.mockReset()
})

describe('GET /api/admin/reviews — real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-D)', () => {
  it('1. a report targeting a real review (reviewer+reviewee real, is_test=false) is returned', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeTableData({
        review_reports: [{ id: 'rep1', reporter_id: 'u1', target_type: 'review', target_id: 'rev1', reason: 'spam', description: null, status: 'open', created_at: '2026-01-01', resolved_at: null, resolved_by: null, resolution_note: null }],
        reviews: [{ id: 'rev1', rating: 1, comment: 'bad', header_snapshot: {}, reviewer_id: 'r1', reviewee_id: 'e1', text_hidden_at: null, invalidated_at: null, published_at: '2026-01-01', is_test: false }],
        profiles: [{ id: 'r1', data_classification: 'real' }, { id: 'e1', data_classification: 'real' }],
        review_moderation_history: [],
      })
    )
    const res = await call()
    const body = await res.json()
    expect(body.reports).toHaveLength(1)
    expect(body.reports[0].id).toBe('rep1')
  })

  it('2. a report targeting an is_test=true review is excluded even though reviewer+reviewee are both real', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeTableData({
        review_reports: [{ id: 'rep2', reporter_id: 'u1', target_type: 'review', target_id: 'rev2', reason: 'spam', description: null, status: 'open', created_at: '2026-01-01', resolved_at: null, resolved_by: null, resolution_note: null }],
        reviews: [{ id: 'rev2', rating: 1, comment: 'bad', header_snapshot: {}, reviewer_id: 'r1', reviewee_id: 'e1', text_hidden_at: null, invalidated_at: null, published_at: '2026-01-01', is_test: true }],
        profiles: [{ id: 'r1', data_classification: 'real' }, { id: 'e1', data_classification: 'real' }],
        review_moderation_history: [],
      })
    )
    const res = await call()
    const body = await res.json()
    expect(body.reports).toEqual([])
  })

  it('3. a report targeting a reply resolves through the reply to its parent review and applies the same real-data rule', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeTableData({
        review_reports: [{ id: 'rep3', reporter_id: 'u1', target_type: 'reply', target_id: 'reply1', reason: 'spam', description: null, status: 'open', created_at: '2026-01-01', resolved_at: null, resolved_by: null, resolution_note: null }],
        review_replies: [{ id: 'reply1', review_id: 'rev3', reply_text: 'thanks', hidden_at: null }],
        reviews: [{ id: 'rev3', rating: 5, comment: 'great', header_snapshot: {}, reviewer_id: 'r1', reviewee_id: 'e1', text_hidden_at: null, invalidated_at: null, published_at: '2026-01-01', is_test: false }],
        profiles: [{ id: 'r1', data_classification: 'unknown' }, { id: 'e1', data_classification: 'real' }],
        review_moderation_history: [],
      })
    )
    const res = await call()
    const body = await res.json()
    expect(body.reports).toEqual([])
  })

  it('4. a report whose target review cannot be resolved at all is excluded, never guessed real', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeTableData({
        review_reports: [{ id: 'rep4', reporter_id: 'u1', target_type: 'review', target_id: 'missing-review', reason: 'spam', description: null, status: 'open', created_at: '2026-01-01', resolved_at: null, resolved_by: null, resolution_note: null }],
        reviews: [],
        profiles: [],
        review_moderation_history: [],
      })
    )
    const res = await call()
    const body = await res.json()
    expect(body.reports).toEqual([])
  })

  it('5. admin authorization is required before any query runs', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(getAdminServiceClient).not.toHaveBeenCalled()
  })
})

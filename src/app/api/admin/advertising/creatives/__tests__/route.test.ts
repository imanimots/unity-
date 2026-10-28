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

function fakeTableData(tables: Record<string, Record<string, unknown>[]>) {
  return {
    from: (table: string) => {
      const rows = tables[table] ?? []
      let filters: Record<string, unknown> = {}
      const obj: Record<string, unknown> = {
        select: () => obj,
        eq: (col: string, val: unknown) => {
          filters = { ...filters, [col]: val }
          return obj
        },
        in: (col: string, vals: unknown[]) => {
          filters = { ...filters, [`__in_${col}`]: vals }
          return obj
        },
        order: () => obj,
        then: (resolve: (v: { data: Record<string, unknown>[]; error: null }) => void) => {
          const matched = rows.filter((r) =>
            Object.entries(filters).every(([k, v]) => (k.startsWith('__in_') ? (v as unknown[]).includes(r[k.replace('__in_', '')]) : r[k] === v))
          )
          resolve({ data: matched, error: null })
        },
      }
      return obj
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

function call() {
  return GET(new NextRequest('http://localhost/api/admin/advertising/creatives'))
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: 'admin', profile: {} } })
  getAdminServiceClient.mockReset()
})

describe('GET /api/admin/advertising/creatives — real-data scope (category: ADMIN-CONTROL-CENTRE-BATCH-D3-E)', () => {
  it('1. a creative whose full chain (campaign -> advertiser -> owner) is real is included', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeTableData({
        ad_creatives: [{ id: 'cr1', campaign_id: 'c1', is_test: false }],
        ad_campaigns: [{ id: 'c1', advertiser_id: 'adv1', is_test: false }],
        ad_advertisers: [{ id: 'adv1', is_test: false, owner_profile_id: 'owner1' }],
        profiles: [{ id: 'owner1', data_classification: 'real' }],
      })
    )
    const res = await call()
    const body = await res.json()
    expect(body.creatives.map((c: { id: string }) => c.id)).toEqual(['cr1'])
  })

  it('2. a creative whose campaign is_test=true is excluded even though advertiser and owner are real', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeTableData({
        ad_creatives: [{ id: 'cr2', campaign_id: 'c2', is_test: false }],
        ad_campaigns: [{ id: 'c2', advertiser_id: 'adv2', is_test: true }],
        ad_advertisers: [{ id: 'adv2', is_test: false, owner_profile_id: 'owner2' }],
        profiles: [{ id: 'owner2', data_classification: 'real' }],
      })
    )
    const res = await call()
    const body = await res.json()
    expect(body.creatives).toEqual([])
  })

  it('3. a creative whose advertiser is_test=true is excluded even though the owner is real', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeTableData({
        ad_creatives: [{ id: 'cr3', campaign_id: 'c3', is_test: false }],
        ad_campaigns: [{ id: 'c3', advertiser_id: 'adv3', is_test: false }],
        ad_advertisers: [{ id: 'adv3', is_test: true, owner_profile_id: 'owner3' }],
        profiles: [{ id: 'owner3', data_classification: 'real' }],
      })
    )
    const res = await call()
    const body = await res.json()
    expect(body.creatives).toEqual([])
  })

  it('4. a creative whose advertiser owner is test is excluded', async () => {
    getAdminServiceClient.mockResolvedValue(
      fakeTableData({
        ad_creatives: [{ id: 'cr4', campaign_id: 'c4', is_test: false }],
        ad_campaigns: [{ id: 'c4', advertiser_id: 'adv4', is_test: false }],
        ad_advertisers: [{ id: 'adv4', is_test: false, owner_profile_id: 'owner4' }],
        profiles: [{ id: 'owner4', data_classification: 'test' }],
      })
    )
    const res = await call()
    const body = await res.json()
    expect(body.creatives).toEqual([])
  })

  it('5. zero real creatives returns an empty list without throwing', async () => {
    getAdminServiceClient.mockResolvedValue(fakeTableData({ ad_creatives: [] }))
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.creatives).toEqual([])
  })

  it('6. admin authorization is required before any query runs', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(getAdminServiceClient).not.toHaveBeenCalled()
  })
})

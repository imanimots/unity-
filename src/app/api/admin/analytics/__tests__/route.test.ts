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

const getMarketplaceOverview = vi.fn()
const getSupplyAnalytics = vi.fn()
const getDemandAnalytics = vi.fn()
const getTransactionAnalytics = vi.fn()
const getTrustAnalytics = vi.fn()
const getCommercialAnalytics = vi.fn()
const getSupportAnalytics = vi.fn()
const getGrowthAnalytics = vi.fn()
const getBehaviorAnalytics = vi.fn()
vi.mock('@/lib/admin/analytics-service', () => ({
  getMarketplaceOverview: (...a: unknown[]) => getMarketplaceOverview(...a),
  getSupplyAnalytics: (...a: unknown[]) => getSupplyAnalytics(...a),
  getDemandAnalytics: (...a: unknown[]) => getDemandAnalytics(...a),
  getTransactionAnalytics: (...a: unknown[]) => getTransactionAnalytics(...a),
  getTrustAnalytics: (...a: unknown[]) => getTrustAnalytics(...a),
  getCommercialAnalytics: (...a: unknown[]) => getCommercialAnalytics(...a),
  getSupportAnalytics: (...a: unknown[]) => getSupportAnalytics(...a),
  getGrowthAnalytics: (...a: unknown[]) => getGrowthAnalytics(...a),
  getBehaviorAnalytics: (...a: unknown[]) => getBehaviorAnalytics(...a),
}))

const { GET } = await import('../route')

const ADMIN_ID = '99999999-9999-9999-9999-999999999999'

function call(qs = '') {
  return GET(new NextRequest(`http://localhost/api/admin/analytics${qs}`))
}

beforeEach(() => {
  requireAdminForRoute.mockReset().mockResolvedValue({ ok: true, requester: { userId: ADMIN_ID, profile: {} } })
  getAdminServiceClient.mockReset().mockResolvedValue({})
  for (const fn of [getMarketplaceOverview, getSupplyAnalytics, getDemandAnalytics, getTransactionAnalytics, getTrustAnalytics, getCommercialAnalytics, getSupportAnalytics, getGrowthAnalytics, getBehaviorAnalytics]) {
    fn.mockReset().mockResolvedValue({})
  }
})

describe('GET /api/admin/analytics (category: ADMIN-CONTROL-CENTRE-BATCH-D1) — authorization + aggregation', () => {
  it('1. a non-admin caller is rejected before any query runs', async () => {
    requireAdminForRoute.mockResolvedValue({ ok: false, response: new Response(JSON.stringify({ error: 'nope' }), { status: 401 }) })
    const res = await call()
    expect(res.status).toBe(401)
    expect(getMarketplaceOverview).not.toHaveBeenCalled()
  })

  it('2. defaults to a 30-day period when none is supplied', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.period).toBe('30d')
    expect(getMarketplaceOverview).toHaveBeenCalledWith(expect.anything(), '30d')
  })

  it('3. an invalid period value falls back to 30d rather than passing through an arbitrary string', async () => {
    const res = await call('?period=forever-and-ever')
    const body = await res.json()
    expect(body.period).toBe('30d')
  })

  it('4. a valid period (7d/90d/all) is forwarded to every analytics function', async () => {
    await call('?period=90d')
    expect(getSupplyAnalytics).toHaveBeenCalledWith(expect.anything(), '90d')
    expect(getSupportAnalytics).toHaveBeenCalledWith(expect.anything(), '90d')
    expect(getBehaviorAnalytics).toHaveBeenCalledWith(expect.anything(), '90d')
  })

  it('5. all nine sections run in one call and are present in the response', async () => {
    const res = await call()
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['behavior', 'commercial', 'demand', 'growth', 'marketplace', 'period', 'supply', 'support', 'transactions', 'trust'])
  })

  it('6. an underlying query failure returns a safe 500, never a raw error leaking storage details', async () => {
    getTrustAnalytics.mockRejectedValue(new Error('internal pg error with sensitive detail'))
    const res = await call()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(JSON.stringify(body)).not.toContain('sensitive detail')
  })

  it('7. storage not configured returns 503, not a crash', async () => {
    getAdminServiceClient.mockResolvedValue(null)
    const res = await call()
    expect(res.status).toBe(503)
  })
})

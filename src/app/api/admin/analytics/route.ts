import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import {
  getMarketplaceOverview,
  getSupplyAnalytics,
  getDemandAnalytics,
  getTransactionAnalytics,
  getTrustAnalytics,
  getCommercialAnalytics,
  getSupportAnalytics,
  getGrowthAnalytics,
  getBehaviorAnalytics,
  type AnalyticsPeriod,
} from '@/lib/admin/analytics-service'

const VALID_PERIODS: AnalyticsPeriod[] = ['7d', '30d', '90d', 'all']

/** GET /api/admin/analytics?period=7d|30d|90d|all — one round trip for the whole real analytics dashboard (ADMIN-CONTROL-CENTRE-BATCH-D1). Read-only, admin-only. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:analytics')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Analytics storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const periodParam = searchParams.get('period')
  const period: AnalyticsPeriod = VALID_PERIODS.includes(periodParam as AnalyticsPeriod) ? (periodParam as AnalyticsPeriod) : '30d'

  try {
    const [marketplace, supply, demand, transactions, trust, commercial, support, growth, behavior] = await Promise.all([
      getMarketplaceOverview(admin, period),
      getSupplyAnalytics(admin, period),
      getDemandAnalytics(admin, period),
      getTransactionAnalytics(admin, period),
      getTrustAnalytics(admin, period),
      getCommercialAnalytics(admin),
      getSupportAnalytics(admin, period),
      getGrowthAnalytics(admin, period),
      getBehaviorAnalytics(admin, period),
    ])

    return NextResponse.json({ period, marketplace, supply, demand, transactions, trust, commercial, support, growth, behavior })
  } catch (err) {
    console.error('[admin.analytics] error', err)
    return NextResponse.json({ error: 'Could not load analytics' }, { status: 500 })
  }
}

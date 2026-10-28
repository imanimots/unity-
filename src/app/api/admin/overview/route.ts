import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getRealUserOverviewCounts } from '@/lib/admin/users-service'

/**
 * GET /api/admin/overview — one RPC round trip
 * (get_admin_overview_stats(), 20260808000002), all aggregation done
 * server-side in SQL. The browser never computes a sensitive total.
 *
 * D3-C: the 6 account-derived fields (total_users/active_users/
 * merchants/renters/suspended_users/restricted_users) are overridden
 * with confirmed-real-only counts, same override as
 * src/app/admin/page.tsx -- see getRealUserOverviewCounts' own doc
 * comment for why and for which fields remain the RPC's unscoped
 * values in this phase.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:overview')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Overview storage is not configured' }, { status: 503 })
  }

  const [{ data, error }, realUserCounts] = await Promise.all([
    admin.rpc('get_admin_overview_stats'),
    getRealUserOverviewCounts(admin),
  ])
  if (error) {
    console.error('[admin.overview] RPC error', error)
    return NextResponse.json({ error: 'Could not load the overview' }, { status: 500 })
  }

  return NextResponse.json({
    ...data,
    total_users: realUserCounts.totalUsers,
    active_users: realUserCounts.activeUsers,
    merchants: realUserCounts.merchants,
    renters: realUserCounts.renters,
    suspended_users: realUserCounts.suspendedUsers,
    restricted_users: realUserCounts.restrictedUsers,
  })
}

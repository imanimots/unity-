import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'

/**
 * GET /api/admin/overview — one RPC round trip
 * (get_admin_overview_stats(), 20260808000002), all aggregation done
 * server-side in SQL. The browser never computes a sensitive total.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:overview')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Overview storage is not configured' }, { status: 503 })
  }

  const { data, error } = await admin.rpc('get_admin_overview_stats')
  if (error) {
    console.error('[admin.overview] RPC error', error)
    return NextResponse.json({ error: 'Could not load the overview' }, { status: 500 })
  }

  return NextResponse.json(data)
}

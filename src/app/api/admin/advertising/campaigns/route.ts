import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'

/** GET /api/admin/advertising/campaigns -- admin review queue, optionally filtered by ?status=. */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:advertising:campaigns:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const status = request.nextUrl.searchParams.get('status')
  let query = admin.from('ad_campaigns').select('*').order('created_at', { ascending: false }).limit(200)
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: 'Could not load campaigns' }, { status: 500 })
  }

  return NextResponse.json({ campaigns: data ?? [] })
}

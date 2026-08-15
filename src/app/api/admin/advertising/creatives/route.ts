import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'

/** GET /api/admin/advertising/creatives -- external creatives, optionally filtered by ?status= (moderation_status). */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:advertising:creatives:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const status = request.nextUrl.searchParams.get('status')
  let query = admin.from('ad_creatives').select('*').order('created_at', { ascending: false }).limit(200)
  if (status) query = query.eq('moderation_status', status)

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: 'Could not load creatives' }, { status: 500 })
  }

  return NextResponse.json({ creatives: data ?? [] })
}

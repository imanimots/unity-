import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'

/**
 * GET /api/admin/advertising/advertisers -- all advertiser accounts,
 * optionally filtered by ?status=.
 *
 * D3-E: real requires ad_advertisers.is_test=false AND the owning
 * profile (owner_profile_id -> profiles.id, FK
 * `ad_advertisers_owner_profile_id_fkey`) positively real. Scoped at
 * the database level via an inner join, before `.limit()`.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:advertising:advertisers:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const status = request.nextUrl.searchParams.get('status')
  let query = admin
    .from('ad_advertisers')
    .select('*, profiles!ad_advertisers_owner_profile_id_fkey!inner(data_classification)')
    .eq('is_test', false)
    .eq('profiles.data_classification', 'real')
    .order('created_at', { ascending: false })
    .limit(200)
  if (status) query = query.eq('status', status)

  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: 'Could not load advertisers' }, { status: 500 })
  }

  // profiles exists only to express the Real Data join filter above --
  // never part of the response shape.
  const advertisers = (data ?? []).map((a) => {
    const row = { ...(a as typeof a & { profiles?: unknown }) }
    delete row.profiles
    return row
  })

  return NextResponse.json({ advertisers })
}

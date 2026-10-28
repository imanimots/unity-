import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'

/**
 * GET /api/admin/advertising/campaigns -- admin review queue,
 * optionally filtered by ?status=.
 *
 * D3-E: real requires ad_campaigns.is_test=false AND the owning
 * advertiser (advertiser_id -> ad_advertisers.id) itself real --
 * ad_advertisers.is_test=false AND its own owner_profile_id positively
 * real. This is a two-hop relationship (campaign -> advertiser ->
 * profile); rather than risk an unverified multi-level PostgREST
 * nested-embed filter, this resolves the advertiser batch separately
 * (never per-row) and filters in memory, with the row-count bound
 * moved to AFTER that filter, same as Disputes/Escrow/Unity Commissions.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:advertising:campaigns:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const status = request.nextUrl.searchParams.get('status')
  let query = admin.from('ad_campaigns').select('*').eq('is_test', false).order('created_at', { ascending: false })
  if (status) query = query.eq('status', status)

  const { data: initialRows, error } = await query
  if (error) {
    return NextResponse.json({ error: 'Could not load campaigns' }, { status: 500 })
  }

  const advertiserIds = Array.from(new Set((initialRows ?? []).map((c) => c.advertiser_id)))
  const { data: advertisers } = advertiserIds.length
    ? await admin
        .from('ad_advertisers')
        .select('id, is_test, owner_profile_id')
        .in('id', advertiserIds)
    : { data: [] }
  const ownerIds = Array.from(new Set((advertisers ?? []).map((a) => a.owner_profile_id)))
  const { data: owners } = ownerIds.length ? await admin.from('profiles').select('id, data_classification').in('id', ownerIds) : { data: [] }
  const ownerById = new Map((owners ?? []).map((o) => [o.id, o.data_classification]))
  const realAdvertiserIds = new Set(
    (advertisers ?? []).filter((a) => a.is_test === false && ownerById.get(a.owner_profile_id) === 'real').map((a) => a.id)
  )

  const campaigns = (initialRows ?? []).filter((c) => realAdvertiserIds.has(c.advertiser_id)).slice(0, 200)

  return NextResponse.json({ campaigns })
}

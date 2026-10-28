import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'

/**
 * GET /api/admin/advertising/creatives -- external creatives,
 * optionally filtered by ?status= (moderation_status).
 *
 * D3-E: real requires ad_creatives.is_test=false AND its campaign real
 * (campaign.is_test=false AND its advertiser real, the exact rule the
 * campaigns route already applies) AND that advertiser's owner profile
 * positively real -- a three-hop chain (creative -> campaign ->
 * advertiser -> profile), resolved via batched (never per-row) queries
 * rather than a multi-level nested PostgREST embed, with the row-count
 * bound moved to AFTER the chain is resolved.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:advertising:creatives:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Advertising storage is not configured' }, { status: 503 })
  }

  const status = request.nextUrl.searchParams.get('status')
  let query = admin.from('ad_creatives').select('*').eq('is_test', false).order('created_at', { ascending: false })
  if (status) query = query.eq('moderation_status', status)

  const { data: initialRows, error } = await query
  if (error) {
    return NextResponse.json({ error: 'Could not load creatives' }, { status: 500 })
  }

  const campaignIds = Array.from(new Set((initialRows ?? []).map((c) => c.campaign_id)))
  const { data: campaigns } = campaignIds.length
    ? await admin.from('ad_campaigns').select('id, is_test, advertiser_id').in('id', campaignIds)
    : { data: [] }
  const advertiserIds = Array.from(new Set((campaigns ?? []).map((c) => c.advertiser_id)))
  const { data: advertisers } = advertiserIds.length
    ? await admin.from('ad_advertisers').select('id, is_test, owner_profile_id').in('id', advertiserIds)
    : { data: [] }
  const ownerIds = Array.from(new Set((advertisers ?? []).map((a) => a.owner_profile_id)))
  const { data: owners } = ownerIds.length ? await admin.from('profiles').select('id, data_classification').in('id', ownerIds) : { data: [] }

  const ownerById = new Map((owners ?? []).map((o) => [o.id, o.data_classification]))
  const realAdvertiserIds = new Set(
    (advertisers ?? []).filter((a) => a.is_test === false && ownerById.get(a.owner_profile_id) === 'real').map((a) => a.id)
  )
  const realCampaignIds = new Set(
    (campaigns ?? []).filter((c) => c.is_test === false && realAdvertiserIds.has(c.advertiser_id)).map((c) => c.id)
  )

  const creatives = (initialRows ?? []).filter((c) => realCampaignIds.has(c.campaign_id)).slice(0, 200)

  return NextResponse.json({ creatives })
}

import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { classifyEntityWithOwner } from '@/lib/admin/data-scope'

/**
 * GET /api/admin/listing-reports — open/closed listing reports, with a
 * safe listing snapshot, for the moderation queue. Never exposes
 * private payment/KYC details -- only what's already safe for public
 * display plus the report's own metadata. Filters to real (non-QA)
 * data only, matching the review-reports admin route's own precedent.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:listing-reports:list')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  try {
    const { data: reports, error } = await admin
      .from('listing_reports')
      .select('id, reporter_id, listing_id, reason, description, status, created_at, resolved_at, resolved_by, resolution_note')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[admin.listing-reports.list] reports query error', error)
      return NextResponse.json({ error: 'Could not load reports' }, { status: 500 })
    }

    const listingIds = Array.from(new Set((reports ?? []).map((r) => r.listing_id)))
    let listingsById = new Map<string, { id: string; title: string; status: string; merchant_id: string; is_test: boolean }>()
    if (listingIds.length > 0) {
      const { data: listings } = await admin
        .from('listings')
        .select('id, title, status, merchant_id, is_test')
        .in('id', listingIds)
      listingsById = new Map((listings ?? []).map((l) => [l.id, l]))
    }

    const merchantIds = Array.from(new Set(Array.from(listingsById.values()).map((l) => l.merchant_id)))
    const { data: merchantProfiles } = merchantIds.length
      ? await admin.from('profiles').select('id, data_classification').in('id', merchantIds)
      : { data: [] }
    const merchantProfileById = new Map((merchantProfiles ?? []).map((p) => [p.id, { data_classification: p.data_classification }]))

    const realReports = (reports ?? []).filter((r) => {
      const listing = listingsById.get(r.listing_id)
      if (!listing) return false
      const merchant = merchantProfileById.get(listing.merchant_id) ?? {}
      return classifyEntityWithOwner({ is_test: listing.is_test === true }, merchant) === 'real'
    })

    const enriched = realReports.slice(0, 200).map((r) => ({
      ...r,
      listing: listingsById.get(r.listing_id) ?? null,
    }))

    return NextResponse.json({ reports: enriched })
  } catch (err) {
    console.error('[admin.listing-reports.list] unexpected error', err)
    return NextResponse.json({ error: 'Could not load reports' }, { status: 500 })
  }
}

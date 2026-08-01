import { NextRequest, NextResponse } from 'next/server'
import { requireAdminForRoute, getAdminServiceClient } from '@/lib/admin/route-helpers'
import { getRiskRequirements } from '@/lib/risk/engine'
import type { RiskTier } from '@/lib/risk/engine'

/**
 * GET /api/admin/listings -- the moderation queue. Reads real persisted
 * state (listings + listing_moderation + listing_ownership_verification),
 * replacing the local-state mock queue in src/app/admin/listings/page.tsx.
 * Deliberately does NOT select any private evidence column or join
 * listing_private_details/listing_media -- "do not expose private
 * evidence in the queue itself" (per the moderation-queue requirements).
 * Evidence is only ever reachable one listing at a time, via the review
 * detail route and the short-lived signed-URL route.
 */
export async function GET(request: NextRequest) {
  const gate = await requireAdminForRoute(request, 'admin:listings:queue')
  if (!gate.ok) return gate.response

  const admin = await getAdminServiceClient()
  if (!admin) {
    return NextResponse.json({ error: 'Listing storage is not configured' }, { status: 503 })
  }

  const { searchParams } = new URL(request.url)
  const moderationStatus = searchParams.get('moderation_status')
  const riskTier = searchParams.get('risk_tier')
  const category = searchParams.get('category')
  const merchantId = searchParams.get('merchant_id')
  const submittedAfter = searchParams.get('submitted_after')
  const submittedBefore = searchParams.get('submitted_before')

  let query = admin
    .from('listings')
    .select(
      `
      id, title, category, risk_tier, status, daily_rate, replacement_value,
      requested_deposit_amount:listing_requirements(requested_deposit_amount),
      merchant_id, created_at,
      profiles!listings_merchant_id_fkey(full_name, account_status),
      listing_moderation(moderation_status, moderated_at),
      listing_ownership_verification(status)
    `
    )
    .order('created_at', { ascending: true })
    .limit(200)

  if (category) query = query.eq('category', category)
  if (riskTier) query = query.eq('risk_tier', riskTier)
  if (merchantId) query = query.eq('merchant_id', merchantId)
  if (submittedAfter) query = query.gte('created_at', submittedAfter)
  if (submittedBefore) query = query.lte('created_at', submittedBefore)

  const { data, error } = await query

  if (error) {
    console.error('[admin.listings.queue] query error', error)
    return NextResponse.json({ error: 'Could not load the moderation queue' }, { status: 500 })
  }

  const now = Date.now()
  const listingIds = (data ?? []).map((row) => row.id)
  const bookingCountByListing = new Map<string, number>()
  if (listingIds.length > 0) {
    const { data: bookingRows } = await admin.from('bookings').select('listing_id').in('listing_id', listingIds)
    for (const b of bookingRows ?? []) {
      bookingCountByListing.set(b.listing_id, (bookingCountByListing.get(b.listing_id) ?? 0) + 1)
    }
  }

  let rows = (data ?? []).map((row) => {
    const moderation = Array.isArray(row.listing_moderation) ? row.listing_moderation[0] : row.listing_moderation
    const ownership = Array.isArray(row.listing_ownership_verification) ? row.listing_ownership_verification[0] : row.listing_ownership_verification
    const requirements = row.risk_tier ? getRiskRequirements(row.risk_tier as RiskTier) : null
    const requestedDeposit = Array.isArray(row.requested_deposit_amount) ? row.requested_deposit_amount[0]?.requested_deposit_amount : undefined
    const merchantProfile = (row as unknown as { profiles?: { full_name: string | null; account_status: string } }).profiles

    return {
      id: row.id,
      title: row.title,
      merchantId: row.merchant_id,
      merchantName: merchantProfile?.full_name ?? null,
      merchantAccountStatus: merchantProfile?.account_status ?? 'active',
      category: row.category,
      riskTier: row.risk_tier,
      listingStatus: row.status,
      moderationStatus: moderation?.moderation_status ?? 'pending',
      ownershipVerificationStatus: ownership?.status ?? (requirements?.ownershipVerificationRequired ? 'pending' : 'not_required'),
      submittedAt: row.created_at,
      replacementValue: row.replacement_value,
      requestedDepositAmount: requestedDeposit ?? null,
      ageDays: Math.floor((now - new Date(row.created_at).getTime()) / (1000 * 60 * 60 * 24)),
      bookingCount: bookingCountByListing.get(row.id) ?? 0,
    }
  })

  if (moderationStatus) {
    rows = rows.filter((r) => r.moderationStatus === moderationStatus)
  }

  if (searchParams.get('format') === 'csv') {
    const { csvResponse } = await import('@/lib/admin/csv')
    return csvResponse(
      'listings.csv',
      ['id', 'title', 'merchantName', 'category', 'riskTier', 'listingStatus', 'moderationStatus', 'ownershipVerificationStatus', 'bookingCount', 'submittedAt'],
      rows
    )
  }

  return NextResponse.json({ listings: rows })
}

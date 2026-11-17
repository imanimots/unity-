import { NextResponse } from 'next/server'
import { getRequestProfile } from '@/lib/supabase/require-admin'

/**
 * GET /api/affiliate/merchant-listings -- the caller's OWN listings with
 * their affiliate settings and commission cost aggregates. Scoped by
 * merchant_id = requester.userId at every query, never another
 * merchant's data.
 */
export async function GET() {
  const requester = await getRequestProfile()
  if (!requester) {
    return NextResponse.json({ error: 'You must be signed in' }, { status: 401 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    return NextResponse.json({ error: 'Affiliate storage is not configured' }, { status: 503 })
  }

  const { createClient } = await import('@supabase/supabase-js')
  const admin = createClient(url, serviceKey)

  const { data: listings, error } = await admin
    .from('listings')
    .select('id, title, accepts_affiliates, affiliate_commission_rate, affiliate_enabled_at, affiliate_disabled_at')
    .eq('merchant_id', requester.userId)
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[affiliate.merchant-listings] error', { userId: requester.userId, error })
    return NextResponse.json({ error: 'Could not load your listings' }, { status: 500 })
  }

  const listingIds = (listings ?? []).map((l) => l.id)
  if (listingIds.length === 0) {
    return NextResponse.json({ listings: [] })
  }

  const [{ data: attributions }, { data: commissions }] = await Promise.all([
    admin.from('affiliate_attributions').select('listing_id, affiliate_id').in('listing_id', listingIds).eq('merchant_id', requester.userId),
    admin.from('affiliate_commissions').select('listing_id, affiliate_id, status, commission_amount, transaction_type').in('listing_id', listingIds).eq('merchant_id', requester.userId),
  ])

  const attributedCountByListing = new Map<string, number>()
  for (const a of attributions ?? []) {
    attributedCountByListing.set(a.listing_id, (attributedCountByListing.get(a.listing_id) ?? 0) + 1)
  }

  // Merchant-visible affiliate identity (name only) -- affiliate_id is
  // already scoped to this merchant's own listings by the queries above
  // (merchant_id = requester.userId, enforced both here and by RLS), so
  // resolving it to a display name is safe: it never crosses into
  // another merchant's attributions/commissions. Resolved via
  // public_profiles (id/display_name/full_name/avatar_url/role/
  // is_verified/unity_score only) -- the same safe, no-PII view used
  // throughout this codebase for showing one user's identity to another,
  // never the base profiles table.
  const affiliateIdsByListing = new Map<string, Set<string>>()
  const addAffiliateToListing = (listingId: string, affiliateId: string | null) => {
    if (!affiliateId) return
    const set = affiliateIdsByListing.get(listingId) ?? new Set<string>()
    set.add(affiliateId)
    affiliateIdsByListing.set(listingId, set)
  }
  for (const a of attributions ?? []) addAffiliateToListing(a.listing_id, a.affiliate_id)
  for (const c of commissions ?? []) addAffiliateToListing(c.listing_id, c.affiliate_id)

  const allAffiliateIds = [...new Set([...affiliateIdsByListing.values()].flatMap((set) => [...set]))]
  const { data: affiliateProfiles } = allAffiliateIds.length
    ? await admin.from('public_profiles').select('id, display_name, full_name').in('id', allAffiliateIds)
    : { data: [] as { id: string; display_name: string | null; full_name: string | null }[] }
  const affiliateNameById = new Map((affiliateProfiles ?? []).map((p) => [p.id, p.display_name || p.full_name || 'Unity affiliate']))

  const eligibleSalesByListing = new Map<string, number>()
  const eligibleRentalsByListing = new Map<string, number>()
  const pendingCostByListing = new Map<string, number>()
  const paidCostByListing = new Map<string, number>()
  const heldCountByListing = new Map<string, number>()

  for (const c of commissions ?? []) {
    if (c.transaction_type === 'sale') eligibleSalesByListing.set(c.listing_id, (eligibleSalesByListing.get(c.listing_id) ?? 0) + 1)
    if (c.transaction_type === 'rental') eligibleRentalsByListing.set(c.listing_id, (eligibleRentalsByListing.get(c.listing_id) ?? 0) + 1)
    if (['pending', 'held', 'approved', 'payout_queued', 'processing'].includes(c.status)) {
      pendingCostByListing.set(c.listing_id, (pendingCostByListing.get(c.listing_id) ?? 0) + c.commission_amount)
    }
    if (c.status === 'paid') {
      paidCostByListing.set(c.listing_id, (paidCostByListing.get(c.listing_id) ?? 0) + c.commission_amount)
    }
    if (c.status === 'held' || c.status === 'failed') {
      heldCountByListing.set(c.listing_id, (heldCountByListing.get(c.listing_id) ?? 0) + 1)
    }
  }

  const shaped = (listings ?? []).map((l) => ({
    id: l.id,
    title: l.title,
    acceptsAffiliates: l.accepts_affiliates,
    commissionRate: l.affiliate_commission_rate,
    affiliateEnabledAt: l.affiliate_enabled_at,
    affiliateDisabledAt: l.affiliate_disabled_at,
    attributedCustomerCount: attributedCountByListing.get(l.id) ?? 0,
    eligibleSales: eligibleSalesByListing.get(l.id) ?? 0,
    eligibleRentalPayments: eligibleRentalsByListing.get(l.id) ?? 0,
    pendingCommissionCost: pendingCostByListing.get(l.id) ?? 0,
    paidCommissionCost: paidCostByListing.get(l.id) ?? 0,
    heldOrExceptionCount: heldCountByListing.get(l.id) ?? 0,
    referrerNames: [...(affiliateIdsByListing.get(l.id) ?? [])].map((id) => affiliateNameById.get(id) ?? 'Unity affiliate'),
  }))

  return NextResponse.json({ listings: shaped })
}

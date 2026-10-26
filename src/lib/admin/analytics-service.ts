import type { SupabaseClient } from '@supabase/supabase-js'
import { getDemandInsights, type DemandInsightsResult } from '@/lib/subscriptions/demand'

/**
 * Real, production-backed analytics for /admin/analytics (ADMIN-CONTROL-
 * CENTRE-BATCH-D1). Every number here comes from an actual Postgres
 * aggregate query against existing tables -- nothing is fabricated, and
 * nothing is read from src/lib/mock/admin-data. Zero new migration:
 * every query below uses columns that already exist in production.
 *
 * Test-data exclusion: `listings`, `marketplace_requests`,
 * `marketplace_request_offers`, `rent_to_buy_agreements`,
 * `search_demand_aggregates`, and `reviews` all carry a real `is_test`
 * column (confirmed directly from their migrations) and every query
 * against them here filters `is_test = false`. `bookings`, `orders`,
 * `barter_agreements`, `disputes`, `profiles`, `unity_commissions`,
 * `affiliate_commissions`, `merchant_payouts`, `merchant_subscriptions`,
 * and `support_cases` have NO such column -- there is no reliable way to
 * exclude QA activity from those domains today, so their counts are
 * reported as-is and the UI must not claim they are test-free.
 *
 * This is designed to be reused later by a future AI R&D/Intelligence
 * module (not built in this phase) -- every exported function returns a
 * plain, typed, already-aggregated result with no UI concerns mixed in.
 */

export type AnalyticsPeriod = '7d' | '30d' | '90d' | 'all'

const PERIOD_DAYS: Record<AnalyticsPeriod, number | null> = { '7d': 7, '30d': 30, '90d': 90, all: null }

function periodSinceIso(period: AnalyticsPeriod): string | null {
  const days = PERIOD_DAYS[period]
  if (days === null) return null
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

/** The immediately preceding period of equal length, e.g. for '30d': the 30 days before the current 30-day window. Null for 'all' -- there is no meaningful "previous all time". */
function previousPeriodRange(period: AnalyticsPeriod): { since: string; until: string } | null {
  const days = PERIOD_DAYS[period]
  if (days === null) return null
  const until = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000)
  return { since: since.toISOString(), until: until.toISOString() }
}

/** A count for the current period alongside the previous period of equal length -- null when the period is 'all' or genuinely not computed. Never a fabricated percentage; callers compute a delta only when both sides are real numbers. */
export interface PeriodComparison {
  current: number
  previous: number | null
}

async function countWhere(
  admin: SupabaseClient,
  table: string,
  eq: Record<string, string | boolean>,
  sinceIso: string | null,
  untilIso?: string
): Promise<number> {
  let q = admin.from(table).select('id', { count: 'exact', head: true })
  for (const [col, val] of Object.entries(eq)) q = q.eq(col, val)
  if (sinceIso) q = q.gte('created_at', sinceIso)
  if (untilIso) q = q.lt('created_at', untilIso)
  const { count, error } = await q
  if (error) throw error
  return count ?? 0
}

async function periodComparison(
  admin: SupabaseClient,
  table: string,
  eq: Record<string, string | boolean>,
  period: AnalyticsPeriod
): Promise<PeriodComparison> {
  const since = periodSinceIso(period)
  const current = await countWhere(admin, table, eq, since)
  const prevRange = previousPeriodRange(period)
  const previous = prevRange ? await countWhere(admin, table, eq, prevRange.since, prevRange.until) : null
  return { current, previous }
}

// ============================================================
// Bounded status enums (D1-F1 remediation) -- known in advance from each
// domain's own Postgres enum, so every "by status" breakdown below is a
// fixed, small number of server-side COUNT queries (never a full-row
// fetch) run in parallel via Promise.all. Values confirmed directly
// from each enum's defining migration, not guessed.
// ============================================================

const BOOKING_STATUSES = ['requested', 'rejected', 'expired', 'cancelled_by_renter', 'cancelled_by_merchant', 'accepted', 'active', 'return_pending', 'returned', 'completed', 'disputed', 'cancelled'] as const
const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'delivered', 'disputed', 'cancelled'] as const
const BARTER_STATUSES = ['proposed', 'countered', 'accepted', 'preparing', 'in_transit', 'awaiting_confirmation', 'completed', 'rejected', 'cancelled', 'expired', 'disputed'] as const
const RTB_STATUSES = ['pending_merchant_acceptance', 'awaiting_first_payment', 'active', 'defaulted', 'return_required', 'completed', 'cancelled', 'disputed'] as const
const MARKETPLACE_REQUEST_STATUSES = ['draft', 'active', 'offers_received', 'matched', 'closed', 'date_passed', 'completed', 'archived'] as const
const DISPUTE_STATUSES = ['open', 'evidence', 'under_review', 'resolved', 'closed', 'cancelled', 'escalated'] as const
const UNITY_COMMISSION_STATUSES = ['pending', 'held', 'earned', 'adjusted', 'voided'] as const
const AFFILIATE_COMMISSION_STATUSES = ['pending', 'held', 'approved', 'payout_queued', 'processing', 'paid', 'failed', 'voided', 'reversed'] as const
const AD_CAMPAIGN_STATUSES = ['draft', 'funded', 'pending_review', 'active', 'paused', 'completed', 'cancelled', 'rejected', 'suspended'] as const
const KYC_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const
const OWNERSHIP_VERIFICATION_STATUSES = ['not_required', 'pending', 'under_review', 'additional_evidence_required', 'verified', 'rejected'] as const
const PAYOUT_STATUSES = ['pending', 'processing', 'paid', 'failed'] as const
const MERCHANT_SUBSCRIPTION_STATUSES = ['active', 'pending_change', 'cancelled'] as const
const MERCHANT_SUBSCRIPTION_PLANS = ['starter', 'pro', 'elite'] as const

/**
 * Per-status COUNT(*), server-side, no row fetch -- `statuses` is a known,
 * bounded enum, so this is always a small, fixed number of parallel count
 * queries regardless of table size (never scales with row count the way
 * fetching every row's status column into Node would).
 */
async function countRowsByStatus(
  admin: SupabaseClient,
  table: string,
  statuses: readonly string[],
  opts: { isTestColumn?: boolean; sinceIso?: string | null; statusColumn?: string } = {}
): Promise<Array<{ label: string; count: number }>> {
  const statusColumn = opts.statusColumn ?? 'status'
  const results = await Promise.all(
    statuses.map(async (status) => {
      let q = admin.from(table).select('id', { count: 'exact', head: true }).eq(statusColumn, status)
      if (opts.isTestColumn) q = q.eq('is_test', false)
      if (opts.sinceIso) q = q.gte('created_at', opts.sinceIso)
      const { count, error } = await q
      if (error) throw error
      return { label: status, count: count ?? 0 }
    })
  )
  return results.filter((r) => r.count > 0)
}

/**
 * Per-status COUNT(*) that EXCLUDES rows whose related listing is a
 * QA/test fixture -- relational test-data exclusion done entirely in
 * Postgres via an inner join + embedded-resource filter
 * (`listings!inner(is_test)` + `.eq('listings.is_test', false)`), never
 * by fetching listing ids into Node and building an IN/NOT IN filter.
 *
 * Verified directly against the real schema before shipping this
 * (D1-F1): for `bookings`/`orders`/`unity_commissions`/
 * `affiliate_commissions`/`ad_campaigns`, this join's real/test
 * partition sums exactly to each table's true total row count (e.g.
 * bookings: 2 real + 1556 test = 1558, the verified total) -- it is a
 * reliable exact count for a standard `listing_id` FK column name.
 *
 * `barter_agreements` is deliberately NOT routed through this helper:
 * its FK column is non-standard (`anchor_listing_id`), and the same
 * verification found the join's real+test partition undercounts the
 * table's true total by 14 rows regardless of which `is_test` value is
 * filtered for -- a genuine PostgREST relationship-resolution
 * discrepancy for this specific column, not a theoretical concern. Per
 * this phase's own instruction ("if the Supabase relationship syntax
 * cannot produce a reliable exact count, stop and report the technical
 * limitation rather than inventing semantics"), barter trades are
 * reported via `countRowsByStatus` instead with `mayIncludeTestData:
 * true`, not silently joined against a count this phase could not
 * verify as correct.
 */
async function countRowsByStatusExcludingTestListings(
  admin: SupabaseClient,
  table: string,
  statuses: readonly string[],
  sinceIso: string | null
): Promise<Array<{ label: string; count: number }>> {
  const results = await Promise.all(
    statuses.map(async (status) => {
      let q = admin
        .from(table)
        .select('id, listings!inner(is_test)', { count: 'exact', head: true })
        .eq('status', status)
        .eq('listings.is_test', false)
      if (sinceIso) q = q.gte('created_at', sinceIso)
      const { count, error } = await q
      if (error) throw error
      return { label: status, count: count ?? 0 }
    })
  )
  return results.filter((r) => r.count > 0)
}

/** Groups rows by a single text column, including a "Missing" bucket for null/empty values, sorted descending. `rows` must already be the narrow, filtered, bounded result of a query -- this never re-queries. */
function groupByColumn(values: Array<string | null>, missingLabel = 'Missing'): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const v of values) {
    const key = v && v.trim() ? v : missingLabel
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count)
}

/** Day-bucketed count, keyed by calendar date in Africa/Johannesburg (not the server's own timezone) -- so a trend line matches what an admin viewing it in South Africa actually expects "today" to mean. */
function bucketByDaySAST(timestamps: string[]): Array<{ date: string; count: number }> {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' })
  const counts = new Map<string, number>()
  for (const ts of timestamps) {
    const key = fmt.format(new Date(ts))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date))
}

// ============================================================
// A. Marketplace overview
// ============================================================

export interface MarketplaceOverview {
  totalUsers: number
  /** account_status <> 'erased'. There is no existing "active user" activity definition in this codebase (no login/session-activity table) -- this is deliberately labeled "non-erased", not "active", to avoid overclaiming. */
  nonErasedUsers: number
  merchantUsers: number
  renterUsers: number
  /** status = 'active', is_test = false, direction = 'available'. */
  realActiveListings: number
  /** Distinct merchant_id among real active listings. */
  realActiveMerchants: number
  newUsers: PeriodComparison
  newRealListings: PeriodComparison
}

export async function getMarketplaceOverview(admin: SupabaseClient, period: AnalyticsPeriod): Promise<MarketplaceOverview> {
  const [
    { count: totalUsers },
    { count: nonErasedUsers },
    { count: merchantUsers },
    { count: renterUsers },
    { data: activeListingRows, count: realActiveListings },
    newUsers,
    newRealListings,
  ] = await Promise.all([
    admin.from('profiles').select('id', { count: 'exact', head: true }),
    admin.from('profiles').select('id', { count: 'exact', head: true }).neq('account_status', 'erased'),
    admin.from('profiles').select('id', { count: 'exact', head: true }).in('role', ['merchant', 'both']),
    admin.from('profiles').select('id', { count: 'exact', head: true }).in('role', ['renter', 'both']),
    admin.from('listings').select('merchant_id', { count: 'exact' }).eq('status', 'active').eq('is_test', false).eq('direction', 'available'),
    periodComparison(admin, 'profiles', {}, period),
    periodComparison(admin, 'listings', { is_test: false }, period),
  ])

  const realActiveMerchants = new Set((activeListingRows ?? []).map((r) => r.merchant_id as string)).size

  return {
    totalUsers: totalUsers ?? 0,
    nonErasedUsers: nonErasedUsers ?? 0,
    merchantUsers: merchantUsers ?? 0,
    renterUsers: renterUsers ?? 0,
    realActiveListings: realActiveListings ?? 0,
    realActiveMerchants,
    newUsers,
    newRealListings,
  }
}

// ============================================================
// B. Supply health
// ============================================================

export interface DataQualityIndicators {
  missingProvince: number
  missingCity: number
  missingCollectionArea: number
  /** Fewer than 3 photos in listing_media -- the master brief's own minimum. Measured only among real, active listings. */
  insufficientMedia: number
  ownershipVerifiedCount: number
  ownershipNotVerifiedCount: number
}

export interface SupplyAnalytics {
  activeListings: number
  activeMerchants: number
  listingsByCategory: Array<{ label: string; count: number }>
  listingsByProvince: Array<{ label: string; count: number }>
  listingCreationTrend: Array<{ date: string; count: number }>
  dataQuality: DataQualityIndicators
}

export async function getSupplyAnalytics(admin: SupabaseClient, period: AnalyticsPeriod): Promise<SupplyAnalytics> {
  const { data: activeListings, error } = await admin
    .from('listings')
    .select('id, merchant_id, category, province, city, collection_area, ownership_verified, created_at')
    .eq('status', 'active')
    .eq('is_test', false)
    .eq('direction', 'available')
  if (error) throw error

  const rows = activeListings ?? []
  const activeMerchants = new Set(rows.map((r) => r.merchant_id as string)).size

  const since = periodSinceIso(period)
  const creationTrendRows = since ? rows.filter((r) => r.created_at >= since) : rows

  const ownershipVerifiedCount = rows.filter((r) => r.ownership_verified).length
  const listingIds = rows.map((r) => r.id as string)

  let insufficientMedia = 0
  if (listingIds.length > 0) {
    const { data: mediaRows, error: mediaError } = await admin.from('listing_media').select('listing_id').in('listing_id', listingIds)
    if (mediaError) throw mediaError
    const mediaCountByListing = new Map<string, number>()
    for (const m of mediaRows ?? []) {
      const id = m.listing_id as string
      mediaCountByListing.set(id, (mediaCountByListing.get(id) ?? 0) + 1)
    }
    insufficientMedia = listingIds.filter((id) => (mediaCountByListing.get(id) ?? 0) < 3).length
  }

  return {
    activeListings: rows.length,
    activeMerchants,
    listingsByCategory: groupByColumn(rows.map((r) => r.category as string | null)),
    listingsByProvince: groupByColumn(rows.map((r) => r.province as string | null)),
    listingCreationTrend: bucketByDaySAST(creationTrendRows.map((r) => r.created_at as string)),
    dataQuality: {
      missingProvince: rows.filter((r) => !r.province).length,
      missingCity: rows.filter((r) => !r.city).length,
      missingCollectionArea: rows.filter((r) => !r.collection_area).length,
      insufficientMedia,
      ownershipVerifiedCount,
      ownershipNotVerifiedCount: rows.length - ownershipVerifiedCount,
    },
  }
}

// ============================================================
// C. Demand / search signals
// ============================================================

export interface LookingForDemand {
  byCategory: Array<{ label: string; count: number }>
  byStatus: Array<{ label: string; count: number }>
  total: number
}

export interface DemandAnalytics {
  /** Reuses the existing, already privacy-thresholded search-demand service (src/lib/subscriptions/demand.ts) -- never a raw per-user search history. */
  searchDemand: DemandInsightsResult
  lookingFor: LookingForDemand
}

export async function getDemandAnalytics(admin: SupabaseClient, period: AnalyticsPeriod): Promise<DemandAnalytics> {
  const windowDays = PERIOD_DAYS[period] ?? 365
  const since = periodSinceIso(period)

  let query = admin.from('marketplace_requests').select('category, status, created_at').eq('is_test', false)
  if (since) query = query.gte('created_at', since)
  const { data, error } = await query
  if (error) throw error

  const rows = data ?? []
  return {
    searchDemand: await getDemandInsights(admin, windowDays),
    lookingFor: {
      byCategory: groupByColumn(rows.map((r) => r.category as string | null)),
      byStatus: groupByColumn(rows.map((r) => r.status as string | null), 'Unknown'),
      total: rows.length,
    },
  }
}

// ============================================================
// D. Transaction activity
// ============================================================

export interface StatusBreakdown {
  domain: string
  total: number
  byStatus: Array<{ label: string; count: number }>
  /**
   * True when this breakdown could NOT be relationally excluded from
   * QA/test activity (either no is_test column exists on the table AND
   * no reliable join path does either, or a join path exists but was
   * verified unreliable -- see countRowsByStatusExcludingTestListings's
   * own comment for barter_agreements specifically). The UI must show a
   * caveat rather than imply this domain is real-only.
   */
  mayIncludeTestData: boolean
}

export interface TransactionAnalytics {
  bookings: StatusBreakdown
  orders: StatusBreakdown
  barter: StatusBreakdown
  rentToBuy: StatusBreakdown
  lookingFor: StatusBreakdown
  /** Explicit, not a number -- see Part F/D of the brief. Live payment settlement is not connected; no figure here is ever presented as real cash. */
  revenueNote: 'not_available_mock_payment_provider'
}

export async function getTransactionAnalytics(admin: SupabaseClient, period: AnalyticsPeriod): Promise<TransactionAnalytics> {
  const since = periodSinceIso(period)

  const [bookingsByStatus, ordersByStatus, barterByStatus, rtbByStatus, lookingForByStatus] = await Promise.all([
    // Relationally excludes bookings tied to a QA/test listing (D1-F1 P1 fix) -- verified exact.
    countRowsByStatusExcludingTestListings(admin, 'bookings', BOOKING_STATUSES, since),
    countRowsByStatusExcludingTestListings(admin, 'orders', ORDER_STATUSES, since),
    // barter_agreements: see countRowsByStatusExcludingTestListings's comment --
    // the join was verified unreliable for this table's anchor_listing_id FK,
    // so this is reported plainly with mayIncludeTestData: true rather than a
    // count this phase could not verify as correct.
    countRowsByStatus(admin, 'barter_agreements', BARTER_STATUSES, { sinceIso: since }),
    countRowsByStatus(admin, 'rent_to_buy_agreements', RTB_STATUSES, { isTestColumn: true, sinceIso: since }),
    countRowsByStatus(admin, 'marketplace_requests', MARKETPLACE_REQUEST_STATUSES, { isTestColumn: true, sinceIso: since }),
  ])

  const total = (rows: Array<{ count: number }>) => rows.reduce((s, r) => s + r.count, 0)

  return {
    bookings: { domain: 'Rental bookings', total: total(bookingsByStatus), byStatus: bookingsByStatus, mayIncludeTestData: false },
    orders: { domain: 'Buy/sell orders', total: total(ordersByStatus), byStatus: ordersByStatus, mayIncludeTestData: false },
    barter: { domain: 'Barter trades', total: total(barterByStatus), byStatus: barterByStatus, mayIncludeTestData: true },
    rentToBuy: { domain: 'Rent-to-Buy', total: total(rtbByStatus), byStatus: rtbByStatus, mayIncludeTestData: false },
    lookingFor: { domain: 'Looking For requests', total: total(lookingForByStatus), byStatus: lookingForByStatus, mayIncludeTestData: false },
    revenueNote: 'not_available_mock_payment_provider',
  }
}

// ============================================================
// E. Trust & verification
// ============================================================

export interface TrustAnalytics {
  kycByStatus: Array<{ label: string; count: number }>
  ownershipVerificationByStatus: Array<{ label: string; count: number }>
  disputesByStatus: StatusBreakdown
  /** Published, non-test reviews created in the period -- not "ratings left" (which includes unpublished/blind reviews not yet visible to anyone). */
  publishedReviews: number
  accountRestrictions: { restricted: number; suspended: number }
}

export async function getTrustAnalytics(admin: SupabaseClient, period: AnalyticsPeriod): Promise<TrustAnalytics> {
  const since = periodSinceIso(period)

  const [kycByStatus, ownershipVerificationByStatus, disputesByStatus, { count: publishedReviews }, { count: restricted }, { count: suspended }] = await Promise.all([
    // Server-side per-status counts (D1-F1 performance fix) -- never a full profiles.kyc_status row fetch.
    countRowsByStatus(admin, 'profiles', KYC_STATUSES, { statusColumn: 'kyc_status' }),
    countRowsByStatus(admin, 'listing_ownership_verification', OWNERSHIP_VERIFICATION_STATUSES, {}),
    // disputes: no reliable, verified relational exclusion path within this
    // phase's narrow scope (2-hop via booking_id/order_id/barter_agreement_id,
    // each a different join target) -- reported plainly, labeled
    // mayIncludeTestData: true per Part 5's "B" fallback, not silently
    // presented as real-only.
    countRowsByStatus(admin, 'disputes', DISPUTE_STATUSES, { sinceIso: since }).then((rows) => ({
      domain: 'Disputes',
      total: rows.reduce((s, r) => s + r.count, 0),
      byStatus: rows,
      mayIncludeTestData: true,
    })),
    (() => {
      let q = admin.from('reviews').select('id', { count: 'exact', head: true }).eq('is_test', false).not('published_at', 'is', null)
      if (since) q = q.gte('created_at', since)
      return q
    })(),
    admin.from('profiles').select('id', { count: 'exact', head: true }).eq('account_status', 'restricted'),
    admin.from('profiles').select('id', { count: 'exact', head: true }).eq('account_status', 'suspended'),
  ])

  return {
    kycByStatus,
    ownershipVerificationByStatus,
    disputesByStatus,
    publishedReviews: publishedReviews ?? 0,
    accountRestrictions: { restricted: restricted ?? 0, suspended: suspended ?? 0 },
  }
}

// ============================================================
// F. Finance / commercial operations
// ============================================================

export interface CommercialAnalytics {
  /** "Recorded commission" -- a real row in unity_commissions by its real status, relationally excluding QA/test-listing-linked rows. Never "revenue": status=earned does not mean cash has moved, since the live payment provider is not fully connected. */
  unityCommissionsByStatus: Array<{ label: string; count: number }>
  /** "Payout record" counts by status -- reflects what the platform has recorded, not a guaranteed bank settlement. No reliable test-exclusion path exists (booking_id is nullable, not a universal boundary) -- see `notes`. */
  merchantPayoutsByStatus: Array<{ label: string; count: number }>
  /** Relationally excludes QA/test-listing-linked rows, same as unityCommissionsByStatus. */
  affiliateCommissionsByStatus: Array<{ label: string; count: number }>
  /** No reliable test-exclusion path exists (no listing/booking relation at all) -- see `notes`. */
  subscriptionsByStatus: Array<{ label: string; count: number }>
  subscriptionsByPlan: Array<{ label: string; count: number }>
  /** "Campaign record" counts -- not ad spend/revenue. Listing-targeted campaigns are relationally excluded when QA/test-linked; non-listing-targeted campaigns (marketplace-request/barter-post/external) have no listing-based test concept and are counted as-is. */
  advertisingCampaignsByStatus: Array<{ label: string; count: number }>
  /** Plain-English caveats for the metrics above that could not be relationally excluded -- never silently presented as real-only. */
  notes: string[]
}

/**
 * Per-status COUNT(*) for a polymorphic table where only SOME rows are
 * listing-linked (ad_campaigns: exactly one of listing_id/
 * marketplace_request_id/barter_skill_task_post_id is set, enforced by
 * a CHECK constraint). A plain `listings!inner` join would incorrectly
 * drop every non-listing-targeted campaign -- instead this sums two
 * server-side counts per status: rows with no listing_id at all (no
 * listing-based test concept applies), plus listing-linked rows whose
 * listing is real (is_test = false). Never fetches a campaign row.
 */
async function countAdCampaignsByStatusExcludingTestListings(admin: SupabaseClient, statuses: readonly string[]): Promise<Array<{ label: string; count: number }>> {
  const results = await Promise.all(
    statuses.map(async (status) => {
      const [{ count: nonListingCount, error: e1 }, { count: realListingCount, error: e2 }] = await Promise.all([
        admin.from('ad_campaigns').select('id', { count: 'exact', head: true }).eq('status', status).is('listing_id', null),
        admin.from('ad_campaigns').select('id, listings!inner(is_test)', { count: 'exact', head: true }).eq('status', status).eq('listings.is_test', false).not('listing_id', 'is', null),
      ])
      if (e1) throw e1
      if (e2) throw e2
      return { label: status, count: (nonListingCount ?? 0) + (realListingCount ?? 0) }
    })
  )
  return results.filter((r) => r.count > 0)
}

export async function getCommercialAnalytics(admin: SupabaseClient): Promise<CommercialAnalytics> {
  const [
    unityCommissionsByStatus,
    merchantPayoutsByStatus,
    affiliateCommissionsByStatus,
    subscriptionsByStatus,
    subscriptionsByPlan,
    advertisingCampaignsByStatus,
  ] = await Promise.all([
    countRowsByStatusExcludingTestListings(admin, 'unity_commissions', UNITY_COMMISSION_STATUSES, null),
    countRowsByStatus(admin, 'merchant_payouts', PAYOUT_STATUSES),
    countRowsByStatusExcludingTestListings(admin, 'affiliate_commissions', AFFILIATE_COMMISSION_STATUSES, null),
    countRowsByStatus(admin, 'merchant_subscriptions', MERCHANT_SUBSCRIPTION_STATUSES),
    countRowsByStatus(admin, 'merchant_subscriptions', MERCHANT_SUBSCRIPTION_PLANS, { statusColumn: 'plan_id' }),
    countAdCampaignsByStatusExcludingTestListings(admin, AD_CAMPAIGN_STATUSES),
  ])

  return {
    unityCommissionsByStatus,
    merchantPayoutsByStatus,
    affiliateCommissionsByStatus,
    subscriptionsByStatus,
    subscriptionsByPlan,
    advertisingCampaignsByStatus,
    notes: [
      'Merchant payout records may include QA/test merchant activity -- no reliable column or relationship excludes it today.',
      'Subscription records may include QA/test merchant accounts -- no reliable column or relationship excludes it today.',
    ],
  }
}

// ============================================================
// G. Support operations (A2 Support Centre)
// ============================================================

export interface SupportAnalytics {
  byStatus: Array<{ label: string; count: number }>
  byPriority: Array<{ label: string; count: number }>
  byCategory: Array<{ label: string; count: number }>
  total: number
}

export async function getSupportAnalytics(admin: SupabaseClient, period: AnalyticsPeriod): Promise<SupportAnalytics> {
  const since = periodSinceIso(period)
  let query = admin.from('support_cases').select('status, priority, category, created_at')
  if (since) query = query.gte('created_at', since)
  const { data, error } = await query
  if (error) throw error
  const rows = data ?? []

  return {
    byStatus: groupByColumn(rows.map((r) => r.status as string | null), 'Unknown'),
    byPriority: groupByColumn(rows.map((r) => r.priority as string | null), 'Unknown'),
    byCategory: groupByColumn(rows.map((r) => r.category as string | null), 'Unknown'),
    total: rows.length,
  }
}

// ============================================================
// H. Growth proxies
// ============================================================

export interface GrowthAnalytics {
  newUsers: PeriodComparison
  newMerchants: PeriodComparison
  newRealListings: PeriodComparison
  newBookings: PeriodComparison
  newOrders: PeriodComparison
}

export async function getGrowthAnalytics(admin: SupabaseClient, period: AnalyticsPeriod): Promise<GrowthAnalytics> {
  const [newUsers, newMerchants, newRealListings, newBookings, newOrders] = await Promise.all([
    periodComparison(admin, 'profiles', {}, period),
    periodComparisonWithIn(admin, 'profiles', 'role', ['merchant', 'both'], period),
    periodComparison(admin, 'listings', { is_test: false }, period),
    periodComparison(admin, 'bookings', {}, period),
    periodComparison(admin, 'orders', {}, period),
  ])

  return { newUsers, newMerchants, newRealListings, newBookings, newOrders }
}

async function countWhereIn(admin: SupabaseClient, table: string, col: string, values: string[], sinceIso: string | null, untilIso?: string): Promise<number> {
  let q = admin.from(table).select('id', { count: 'exact', head: true }).in(col, values)
  if (sinceIso) q = q.gte('created_at', sinceIso)
  if (untilIso) q = q.lt('created_at', untilIso)
  const { count, error } = await q
  if (error) throw error
  return count ?? 0
}

async function periodComparisonWithIn(admin: SupabaseClient, table: string, col: string, values: string[], period: AnalyticsPeriod): Promise<PeriodComparison> {
  const since = periodSinceIso(period)
  const current = await countWhereIn(admin, table, col, values, since)
  const prevRange = previousPeriodRange(period)
  const previous = prevRange ? await countWhereIn(admin, table, col, values, prevRange.since, prevRange.until) : null
  return { current, previous }
}

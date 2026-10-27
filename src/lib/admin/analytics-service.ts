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
 * `unity_commissions`, `affiliate_commissions`, and listing-targeted
 * `ad_campaigns` rows have no `is_test` column of their own but DO have
 * a direct (or, for `barter_agreements`, two mutually-exclusive) FK to
 * a table that does -- those are relationally excluded via an inner
 * join instead (see `countRowsByStatusExcludingTestListings` and
 * `countBarterByStatusExcludingTestAnchors`). `disputes`, `profiles`,
 * `merchant_payouts`, `merchant_subscriptions`, and `support_cases`
 * have no `is_test` column AND no reliable join path (too many hops,
 * or no listing/booking relation at all) -- those counts are reported
 * as-is, with explicit `mayIncludeTestData`/`notes` metadata the UI
 * must surface rather than silently imply test-free.
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
  opts: { isTestColumn?: boolean; sinceIso?: string | null; statusColumn?: string; idColumn?: string } = {}
): Promise<Array<{ label: string; count: number }>> {
  const statusColumn = opts.statusColumn ?? 'status'
  // Most tables here have a real `id` primary key; listing_ownership_verification
  // does not (its PK is listing_id) -- D1-H1 hotfix, confirmed 42703 in
  // production ("column listing_ownership_verification.id does not exist").
  const idColumn = opts.idColumn ?? 'id'
  const results = await Promise.all(
    statuses.map(async (status) => {
      let q = admin.from(table).select(idColumn, { count: 'exact', head: true }).eq(statusColumn, status)
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
 * Verified directly against the real schema (D1-F1, re-confirmed F2):
 * for `bookings`/`orders`/`unity_commissions`/`affiliate_commissions`/
 * `ad_campaigns`, this join's real/test partition sums exactly to each
 * table's true total row count (e.g. bookings: 2 real + 1556 test =
 * 1558, the verified total) -- it is a reliable exact count for a
 * standard `listing_id` FK column name.
 *
 * `barter_agreements` is NOT routed through this helper -- it has two
 * mutually-exclusive anchor types (see
 * `countBarterByStatusExcludingTestAnchors` below), not one.
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

/**
 * Per-status COUNT(*) for barter_agreements' real (non-test) activity,
 * combining BOTH of its two mutually-exclusive anchor types (enforced
 * by the `barter_agreements_exactly_one_anchor_chk` CHECK constraint --
 * every row has exactly one of these, never both, never neither):
 *
 *   A. listing-anchored: anchor_listing_id -> listings.is_test
 *   B. skill/task-anchored: anchor_skill_task_post_id ->
 *      barter_skill_task_posts.is_test
 *
 * Branch B requires the explicit FK-constraint-name hint
 * (`barter_agreements_anchor_skill_task_post_id_fkey`): verified live
 * (D1-F1 re-review) that `barter_agreements` has TWO separate foreign
 * keys to `barter_skill_task_posts` -- the other, `source_skill_task_
 * post_id`, drives the Looking-For/offer-matching lifecycle and is
 * never the trade's anchor. An unhinted embed fails outright with
 * PostgREST's own "more than one relationship was found" ambiguity
 * error rather than silently resolving to the wrong one, so the
 * correct relationship is named explicitly, never left to inference.
 *
 * Two bounded COUNT queries per status (one per branch), summed in
 * application code -- never a row fetch, never a per-row query.
 * Verified live that the two branches' real+test partitions each sum
 * exactly to their own subset's true total (listing-anchored: 0 real +
 * 455 test = 455; skill/task-anchored: 0 real + 14 test = 14; combined
 * 455 + 14 = 469, the table's full true total with zero rows
 * unaccounted for) -- there was never a PostgREST relationship-
 * resolution discrepancy, only an undiscovered second anchor path.
 *
 * D1-H1 hotfix: the finite-period lower bound filters on `proposed_at`,
 * NOT `created_at` -- `barter_agreements` has no `created_at` column
 * at all (confirmed live: Postgres 42703 "column barter_agreements.
 * created_at does not exist", with its own hint pointing at the
 * similarly-named but semantically wrong `accepted_at`/`updated_at`).
 * `proposed_at` is the real creation timestamp, set once when a trade
 * is first proposed and never touched again.
 */
async function countBarterByStatusExcludingTestAnchors(admin: SupabaseClient, statuses: readonly string[], sinceIso: string | null): Promise<Array<{ label: string; count: number }>> {
  const results = await Promise.all(
    statuses.map(async (status) => {
      const [{ count: listingAnchored, error: e1 }, { count: skillTaskAnchored, error: e2 }] = await Promise.all([
        (() => {
          let q = admin.from('barter_agreements').select('id, listings!inner(is_test)', { count: 'exact', head: true }).eq('status', status).eq('listings.is_test', false)
          if (sinceIso) q = q.gte('proposed_at', sinceIso)
          return q
        })(),
        (() => {
          let q = admin
            .from('barter_agreements')
            .select('id, barter_skill_task_posts!barter_agreements_anchor_skill_task_post_id_fkey!inner(is_test)', { count: 'exact', head: true })
            .eq('status', status)
            .eq('barter_skill_task_posts.is_test', false)
          if (sinceIso) q = q.gte('proposed_at', sinceIso)
          return q
        })(),
      ])
      if (e1) throw e1
      if (e2) throw e2
      return { label: status, count: (listingAnchored ?? 0) + (skillTaskAnchored ?? 0) }
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
    // Relationally excludes bookings/orders tied to a QA/test listing (D1-F1 P1 fix) -- verified exact.
    countRowsByStatusExcludingTestListings(admin, 'bookings', BOOKING_STATUSES, since),
    countRowsByStatusExcludingTestListings(admin, 'orders', ORDER_STATUSES, since),
    // barter_agreements: relationally excludes BOTH anchor types (D1-F2) -- see countBarterByStatusExcludingTestAnchors's own comment.
    countBarterByStatusExcludingTestAnchors(admin, BARTER_STATUSES, since),
    countRowsByStatus(admin, 'rent_to_buy_agreements', RTB_STATUSES, { isTestColumn: true, sinceIso: since }),
    countRowsByStatus(admin, 'marketplace_requests', MARKETPLACE_REQUEST_STATUSES, { isTestColumn: true, sinceIso: since }),
  ])

  const total = (rows: Array<{ count: number }>) => rows.reduce((s, r) => s + r.count, 0)

  return {
    bookings: { domain: 'Rental bookings', total: total(bookingsByStatus), byStatus: bookingsByStatus, mayIncludeTestData: false },
    orders: { domain: 'Buy/sell orders', total: total(ordersByStatus), byStatus: ordersByStatus, mayIncludeTestData: false },
    barter: { domain: 'Barter trades', total: total(barterByStatus), byStatus: barterByStatus, mayIncludeTestData: false },
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
    countRowsByStatus(admin, 'listing_ownership_verification', OWNERSHIP_VERIFICATION_STATUSES, { idColumn: 'listing_id' }),
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
    // D1-H2 hotfix: the live column is current_plan_id -- there is no bare
    // plan_id column, and pending_plan_id is a different, future-scheduled
    // plan (confirmed live: 42703 "column merchant_subscriptions.plan_id
    // does not exist").
    countRowsByStatus(admin, 'merchant_subscriptions', MERCHANT_SUBSCRIPTION_PLANS, { statusColumn: 'current_plan_id' }),
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
    // Relationally excludes test-listing-linked bookings/orders (D1-F2) --
    // the same real-only rule Transaction Analytics already applies to
    // these two tables.
    periodComparisonExcludingTestListings(admin, 'bookings', period),
    periodComparisonExcludingTestListings(admin, 'orders', period),
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

/** Same `listings!inner(is_test)` relational exclusion as countRowsByStatusExcludingTestListings, but over a date range (current/previous period) instead of a single status -- used by Growth Analytics' real-only new-bookings/new-orders counts. */
async function countRealListingLinkedInRange(admin: SupabaseClient, table: string, sinceIso: string | null, untilIso?: string): Promise<number> {
  let q = admin.from(table).select('id, listings!inner(is_test)', { count: 'exact', head: true }).eq('listings.is_test', false)
  if (sinceIso) q = q.gte('created_at', sinceIso)
  if (untilIso) q = q.lt('created_at', untilIso)
  const { count, error } = await q
  if (error) throw error
  return count ?? 0
}

async function periodComparisonExcludingTestListings(admin: SupabaseClient, table: string, period: AnalyticsPeriod): Promise<PeriodComparison> {
  const since = periodSinceIso(period)
  const current = await countRealListingLinkedInRange(admin, table, since)
  const prevRange = previousPeriodRange(period)
  const previous = prevRange ? await countRealListingLinkedInRange(admin, table, prevRange.since, prevRange.until) : null
  return { current, previous }
}

// ============================================================
// I. Behavior & conversion (D2 -- first-party event analytics)
// ============================================================

/** completed/started, or null (never Infinity/NaN/0%) when there is nothing to divide by. */
export interface FunnelMetric {
  started: number
  completed: number
  conversionRate: number | null
}

export interface BehaviorAnalytics {
  pageViews: number
  searchStarted: number
  searchResultsViewed: number
  zeroResultSearches: number
  zeroResultRate: number | null
  searchRefinements: number
  listingViews: number
  signupFunnel: FunnelMetric
  listingCreationFunnel: FunnelMetric
  rentalFunnel: FunnelMetric
  orderFunnel: FunnelMetric
  kycFunnel: FunnelMetric
  dataQuality: {
    /** False only when analytics_events has no rows at all yet -- distinguishes "genuinely zero activity this period" from "D2 instrumentation has no historical data at all" (Section 30/31: zero data is expected and must never be mistaken for a broken response). */
    hasAnyEventData: boolean
    /** Most D2 events have no authoritative per-row test/QA signal (no profile-level is_test marker exists in this codebase -- see analytics-service.ts's own D1 header comment for the equivalent database-side limitation). Confirmed-test rows (data_classification = 'test', derived server-side from a related listing's real is_test column) are always excluded from every count below; everything else ('real' or 'unknown') is counted, so these numbers may still include some unclassified QA/test browsing activity. */
    mayIncludeUnclassifiedActivity: boolean
    notes: string[]
  }
}

function safeConversionRate(started: number, completed: number): number | null {
  if (started <= 0) return null
  return completed / started
}

function emptyBehaviorAnalytics(extraNote?: string): BehaviorAnalytics {
  const notes = [
    'Most behavioral events have no authoritative per-row test/QA signal (no profile-level is_test marker exists) -- confirmed-test rows are excluded, but counts may still include some unclassified QA/test browsing activity.',
    'Behavioral event data begins from when D2 instrumentation was deployed -- no historical events were backfilled from existing database rows.',
  ]
  if (extraNote) notes.push(extraNote)
  return {
    pageViews: 0,
    searchStarted: 0,
    searchResultsViewed: 0,
    zeroResultSearches: 0,
    zeroResultRate: null,
    searchRefinements: 0,
    listingViews: 0,
    signupFunnel: { started: 0, completed: 0, conversionRate: null },
    listingCreationFunnel: { started: 0, completed: 0, conversionRate: null },
    rentalFunnel: { started: 0, completed: 0, conversionRate: null },
    orderFunnel: { started: 0, completed: 0, conversionRate: null },
    kycFunnel: { started: 0, completed: 0, conversionRate: null },
    dataQuality: { hasAnyEventData: false, mayIncludeUnclassifiedActivity: true, notes },
  }
}

/** Server-side exact COUNT(*) for one event_name, over the period window, always excluding confirmed-test rows (data_classification = 'test') -- never a full-row fetch, matching every other count in this file. */
async function countAnalyticsEvents(admin: SupabaseClient, eventName: string, sinceIso: string | null): Promise<number> {
  let q = admin.from('analytics_events').select('id', { count: 'exact', head: true }).eq('event_name', eventName).neq('data_classification', 'test')
  if (sinceIso) q = q.gte('occurred_at', sinceIso)
  const { count, error } = await q
  if (error) throw error
  return count ?? 0
}

/**
 * Behavior & Conversion (D2). This is the one analytics section backed
 * by a table that may not exist yet in a given environment -- the D2
 * migration is deliberately NOT applied as part of this same phase
 * (Section 9/36). A missing-relation error here must degrade to the
 * same safe all-zero/null shape zero *data* already requires (Section
 * 30), not throw -- throwing would fail the whole /api/admin/analytics
 * response via its Promise.all, exactly the class of production bug
 * D1-H1/H2 just fixed for two other sections. Any other, non-missing-
 * table error still throws, since that would be a genuine bug worth
 * surfacing rather than a deployment-ordering gap.
 *
 * D2-F1 fix: the existence probe below is deliberately NOT a
 * `head: true` request. Live-verified (D2 independent review) that a
 * `head: true` query against a genuinely nonexistent table returns
 * `{ count: null, error: null }` -- no error object at all, not even
 * the already-documented `{message: ''}` masked shape -- so the
 * original `if (probe.error.code === 'PGRST205' ...)` check was
 * unreachable dead code for the real deployment-ordering gap it was
 * written for. A small, bounded, non-head `select(...).limit(1)`
 * lets PostgREST return its real error body, so the intended
 * PGRST205/42P01 check actually fires, and any OTHER real error
 * (permissions, a bad column, a bad relationship, a network failure)
 * still correctly propagates instead of being fake-zeroed.
 */
export async function getBehaviorAnalytics(admin: SupabaseClient, period: AnalyticsPeriod): Promise<BehaviorAnalytics> {
  const since = periodSinceIso(period)

  const probe = await admin.from('analytics_events').select('event_id').limit(1)
  if (probe.error) {
    if (probe.error.code === 'PGRST205' || probe.error.code === '42P01') {
      return emptyBehaviorAnalytics('analytics_events does not exist yet in this environment -- the D2 migration has not been applied here.')
    }
    throw probe.error
  }
  const hasAnyEventData = (probe.data?.length ?? 0) > 0

  const [
    pageViews,
    searchStarted,
    searchResultsViewed,
    zeroResultSearches,
    searchRefinements,
    listingViews,
    signupStarted,
    signupCompleted,
    listingCreationStarted,
    listingPublished,
    rentalCheckoutStarted,
    bookingsCreated,
    orderCheckoutStarted,
    ordersCreated,
    kycStarted,
    kycSubmitted,
  ] = await Promise.all([
    countAnalyticsEvents(admin, 'page_view', since),
    countAnalyticsEvents(admin, 'search_started', since),
    countAnalyticsEvents(admin, 'search_results_viewed', since),
    countAnalyticsEvents(admin, 'search_zero_results', since),
    countAnalyticsEvents(admin, 'search_refined', since),
    countAnalyticsEvents(admin, 'listing_viewed', since),
    countAnalyticsEvents(admin, 'signup_started', since),
    countAnalyticsEvents(admin, 'signup_completed', since),
    countAnalyticsEvents(admin, 'listing_creation_started', since),
    countAnalyticsEvents(admin, 'listing_published', since),
    countAnalyticsEvents(admin, 'rental_checkout_started', since),
    countAnalyticsEvents(admin, 'booking_created', since),
    countAnalyticsEvents(admin, 'order_checkout_started', since),
    countAnalyticsEvents(admin, 'order_created', since),
    countAnalyticsEvents(admin, 'kyc_started', since),
    countAnalyticsEvents(admin, 'kyc_submitted', since),
  ])

  return {
    pageViews,
    searchStarted,
    searchResultsViewed,
    zeroResultSearches,
    zeroResultRate: safeConversionRate(searchStarted, zeroResultSearches),
    searchRefinements,
    listingViews,
    signupFunnel: { started: signupStarted, completed: signupCompleted, conversionRate: safeConversionRate(signupStarted, signupCompleted) },
    listingCreationFunnel: { started: listingCreationStarted, completed: listingPublished, conversionRate: safeConversionRate(listingCreationStarted, listingPublished) },
    rentalFunnel: { started: rentalCheckoutStarted, completed: bookingsCreated, conversionRate: safeConversionRate(rentalCheckoutStarted, bookingsCreated) },
    orderFunnel: { started: orderCheckoutStarted, completed: ordersCreated, conversionRate: safeConversionRate(orderCheckoutStarted, ordersCreated) },
    kycFunnel: { started: kycStarted, completed: kycSubmitted, conversionRate: safeConversionRate(kycStarted, kycSubmitted) },
    dataQuality: {
      hasAnyEventData,
      mayIncludeUnclassifiedActivity: true,
      notes: [
        'Most behavioral events have no authoritative per-row test/QA signal (no profile-level is_test marker exists) -- confirmed-test rows are excluded, but counts may still include some unclassified QA/test browsing activity.',
        'Behavioral event data begins from when D2 instrumentation was deployed -- no historical events were backfilled from existing database rows.',
      ],
    },
  }
}

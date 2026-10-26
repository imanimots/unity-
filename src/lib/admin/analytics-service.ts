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

async function statusBreakdown(admin: SupabaseClient, domain: string, table: string, period: AnalyticsPeriod, isTestFilter: boolean): Promise<StatusBreakdown> {
  const since = periodSinceIso(period)
  let query = admin.from(table).select('status, created_at')
  if (isTestFilter) query = query.eq('is_test', false)
  if (since) query = query.gte('created_at', since)
  const { data, error } = await query
  if (error) throw error
  const rows = data ?? []
  return { domain, total: rows.length, byStatus: groupByColumn(rows.map((r) => r.status as string | null), 'Unknown') }
}

export async function getTransactionAnalytics(admin: SupabaseClient, period: AnalyticsPeriod): Promise<TransactionAnalytics> {
  const [bookings, orders, barter, rentToBuy, lookingFor] = await Promise.all([
    statusBreakdown(admin, 'Rental bookings', 'bookings', period, false),
    statusBreakdown(admin, 'Buy/sell orders', 'orders', period, false),
    statusBreakdown(admin, 'Barter trades', 'barter_agreements', period, false),
    statusBreakdown(admin, 'Rent-to-Buy', 'rent_to_buy_agreements', period, true),
    statusBreakdown(admin, 'Looking For requests', 'marketplace_requests', period, true),
  ])

  return { bookings, orders, barter, rentToBuy, lookingFor, revenueNote: 'not_available_mock_payment_provider' }
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

  const [
    { data: kycRows, error: kycError },
    { data: ownershipRows, error: ownershipError },
    disputes,
    { count: publishedReviews },
    { count: restricted },
    { count: suspended },
  ] = await Promise.all([
    admin.from('profiles').select('kyc_status'),
    admin.from('listing_ownership_verification').select('status'),
    statusBreakdown(admin, 'Disputes', 'disputes', period, false),
    (() => {
      let q = admin.from('reviews').select('id', { count: 'exact', head: true }).eq('is_test', false).not('published_at', 'is', null)
      if (since) q = q.gte('created_at', since)
      return q
    })(),
    admin.from('profiles').select('id', { count: 'exact', head: true }).eq('account_status', 'restricted'),
    admin.from('profiles').select('id', { count: 'exact', head: true }).eq('account_status', 'suspended'),
  ])
  if (kycError) throw kycError
  if (ownershipError) throw ownershipError

  return {
    kycByStatus: groupByColumn((kycRows ?? []).map((r) => r.kyc_status as string | null), 'Unknown'),
    ownershipVerificationByStatus: groupByColumn((ownershipRows ?? []).map((r) => r.status as string | null), 'Unknown'),
    disputesByStatus: disputes,
    publishedReviews: publishedReviews ?? 0,
    accountRestrictions: { restricted: restricted ?? 0, suspended: suspended ?? 0 },
  }
}

// ============================================================
// F. Finance / commercial operations
// ============================================================

export interface CommercialAnalytics {
  /** "Recorded commission" -- a real row in unity_commissions by its real status. Never "revenue": status=earned does not mean cash has moved, since the live payment provider is not fully connected. */
  unityCommissionsByStatus: Array<{ label: string; count: number }>
  /** "Payout record" counts by status -- reflects what the platform has recorded, not a guaranteed bank settlement. */
  merchantPayoutsByStatus: Array<{ label: string; count: number }>
  affiliateCommissionsByStatus: Array<{ label: string; count: number }>
  subscriptionsByStatus: Array<{ label: string; count: number }>
  subscriptionsByPlan: Array<{ label: string; count: number }>
  /** "Campaign record" counts -- not ad spend/revenue. */
  advertisingCampaignsByStatus: Array<{ label: string; count: number }>
}

export async function getCommercialAnalytics(admin: SupabaseClient): Promise<CommercialAnalytics> {
  const [
    { data: commissionRows, error: commissionError },
    { data: payoutRows, error: payoutError },
    { data: affiliateRows, error: affiliateError },
    { data: subRows, error: subError },
    { data: campaignRows, error: campaignError },
  ] = await Promise.all([
    admin.from('unity_commissions').select('status'),
    admin.from('merchant_payouts').select('status'),
    admin.from('affiliate_commissions').select('status'),
    admin.from('merchant_subscriptions').select('status, plan_id'),
    admin.from('ad_campaigns').select('status'),
  ])
  if (commissionError) throw commissionError
  if (payoutError) throw payoutError
  if (affiliateError) throw affiliateError
  if (subError) throw subError
  if (campaignError) throw campaignError

  return {
    unityCommissionsByStatus: groupByColumn((commissionRows ?? []).map((r) => r.status as string | null), 'Unknown'),
    merchantPayoutsByStatus: groupByColumn((payoutRows ?? []).map((r) => r.status as string | null), 'Unknown'),
    affiliateCommissionsByStatus: groupByColumn((affiliateRows ?? []).map((r) => r.status as string | null), 'Unknown'),
    subscriptionsByStatus: groupByColumn((subRows ?? []).map((r) => r.status as string | null), 'Unknown'),
    subscriptionsByPlan: groupByColumn((subRows ?? []).map((r) => r.plan_id as string | null), 'Unknown'),
    advertisingCampaignsByStatus: groupByColumn((campaignRows ?? []).map((r) => r.status as string | null), 'Unknown'),
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

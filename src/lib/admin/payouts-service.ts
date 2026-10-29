import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyEntityWithOwners } from '@/lib/admin/data-scope'

const DEFAULT_LIMIT = 100

/**
 * D3-E-F1: listAdminPayouts() below is backed entirely by
 * _admin_list_merchant_payouts. D3-E's independent review confirmed the
 * RPC (as it stood after 20260904000022_admin_payout_search_relational.sql)
 * had zero Real Data provenance filtering -- the same class of gap
 * _admin_list_orders_page had in D3-D, fixed there via a new
 * CREATE OR REPLACE migration. The identical fix now exists at
 * supabase/migrations/20261029090000_admin_payouts_real_data_scope.sql
 * (merchant real always required; booking-linked payouts additionally
 * require the COMPLETE booking rule -- renter real AND listing
 * non-test, the exact rule getAdminPayoutDetail below already applies).
 * That migration is a reviewed SOURCE FILE only -- this phase does not
 * apply it (no database migration/mutation occurs here); until it is
 * applied, this RPC's live behavior in any already-deployed environment
 * remains unscoped. getAdminPayoutDetail below is a plain table query
 * with no such constraint, so it is already scoped directly and
 * requires no migration.
 */

export interface AdminPayoutRow {
  id: string
  payoutReference: string | null
  merchantId: string
  merchantName: string | null
  bookingId: string | null
  bookingReference: string | null
  listingTitle: string | null
  amount: number
  /** merchant_payouts has no currency column -- the platform is ZAR-only throughout, so this is a fixed literal, not a lookup. */
  currency: 'ZAR'
  status: string
  createdAt: string
  processingStartedAt: string | null
  paidAt: string | null
  failedAt: string | null
  failureCategory: string | null
  attemptCount: number
  hasUnresolvedDispute: boolean
  merchantRestricted: boolean
}

export interface AdminPayoutFilters {
  search?: string
  status?: string
  failedOnly?: boolean
  overdueOnly?: boolean
  disputeRelated?: boolean
  restrictedMerchant?: boolean
  dateFrom?: string
  dateTo?: string
  limit?: number
}

interface AdminListMerchantPayoutsRpcRow {
  id: string
  payout_reference: string | null
  merchant_id: string
  merchant_name: string | null
  booking_id: string | null
  booking_reference: string | null
  listing_title: string | null
  amount: number
  status: string
  created_at: string
  processing_started_at: string | null
  paid_at: string | null
  failed_at: string | null
  failure_category: string | null
  attempt_count: number
  has_unresolved_dispute: boolean
  merchant_restricted: boolean
}

/**
 * Bounded, relational search via _admin_list_merchant_payouts (migration
 * 20260904000022) -- replaces the prior "fetch top 100 by created_at,
 * then filter in Node" shape, which made search structurally blind to
 * any payout ranked outside that window. All filters, including search,
 * are now applied server-side against the full eligible set before the
 * LIMIT, eliminating the false-negative without removing the bound.
 */
export async function listAdminPayouts(admin: SupabaseClient, filters: AdminPayoutFilters): Promise<AdminPayoutRow[]> {
  const { data: rows, error } = await admin.rpc('_admin_list_merchant_payouts', {
    p_search: filters.search ?? null,
    p_status: filters.status ?? null,
    p_failed_only: filters.failedOnly ?? false,
    p_overdue_only: filters.overdueOnly ?? false,
    p_dispute_related: filters.disputeRelated ?? false,
    p_restricted_merchant: filters.restrictedMerchant ?? false,
    p_date_from: filters.dateFrom ?? null,
    p_date_to: filters.dateTo ?? null,
    p_limit: filters.limit ?? DEFAULT_LIMIT,
  })
  if (error) throw error

  return ((rows ?? []) as AdminListMerchantPayoutsRpcRow[]).map((r) => ({
    id: r.id,
    payoutReference: r.payout_reference,
    merchantId: r.merchant_id,
    merchantName: r.merchant_name,
    bookingId: r.booking_id,
    bookingReference: r.booking_reference,
    listingTitle: r.listing_title,
    amount: r.amount,
    currency: 'ZAR',
    status: r.status,
    createdAt: r.created_at,
    processingStartedAt: r.processing_started_at,
    paidAt: r.paid_at,
    failedAt: r.failed_at,
    failureCategory: r.failure_category,
    attemptCount: r.attempt_count,
    hasUnresolvedDispute: r.has_unresolved_dispute,
    merchantRestricted: r.merchant_restricted,
  }))
}

export interface AdminPayoutDetail {
  payout: Record<string, unknown>
  merchantName: string | null
  merchantAccountStatus: string | null
  booking: Record<string, unknown> | null
  listingTitle: string | null
  rentalPayment: Record<string, unknown> | null
  depositPayment: Record<string, unknown> | null
  disputes: Record<string, unknown>[]
  history: Record<string, unknown>[]
  emailDeliveries: Record<string, unknown>[]
}

export async function getAdminPayoutDetail(admin: SupabaseClient, payoutId: string): Promise<AdminPayoutDetail | null> {
  const { data: payout, error } = await admin.from('merchant_payouts').select('*').eq('id', payoutId).maybeSingle()
  if (error) throw error
  if (!payout) return null

  // D3-E: a known test/unknown-linked payout id must not load as an
  // ordinary Real Data payout detail -- checked before the merchant/
  // booking/payments/history/email fetches below. A payout always has
  // merchant_id; when booking_id is also set, the payout inherits the
  // COMPLETE booking rule (renter+merchant+listing.is_test), never
  // merchant-real alone -- the same relationship bookings' own
  // real-data rule already uses.
  const { data: scopeMerchant } = await admin.from('profiles').select('id, data_classification').eq('id', payout.merchant_id).maybeSingle()
  if (payout.booking_id) {
    const { data: scopeBooking } = await admin.from('bookings').select('renter_id, listing_id').eq('id', payout.booking_id).maybeSingle()
    if (!scopeBooking) return null
    const [{ data: scopeRenter }, { data: scopeListing }] = await Promise.all([
      admin.from('profiles').select('id, data_classification').eq('id', scopeBooking.renter_id).maybeSingle(),
      admin.from('listings').select('is_test').eq('id', scopeBooking.listing_id).maybeSingle(),
    ])
    if (classifyEntityWithOwners({ is_test: scopeListing?.is_test === true }, [scopeRenter ?? {}, scopeMerchant ?? {}]) !== 'real') return null
  } else if (classifyEntityWithOwners({ is_test: false }, [scopeMerchant ?? {}]) !== 'real') {
    return null
  }

  const [{ data: merchant }, { data: booking }, { data: payments }, { data: history }, { data: emailDeliveries }] = await Promise.all([
    admin.from('profiles').select('full_name, display_name, account_status').eq('id', payout.merchant_id).maybeSingle(),
    payout.booking_id ? admin.from('bookings').select('*').eq('id', payout.booking_id).maybeSingle() : Promise.resolve({ data: null }),
    payout.booking_id ? admin.from('payments').select('*').eq('booking_id', payout.booking_id) : Promise.resolve({ data: [] }),
    admin.from('merchant_payout_history').select('*').eq('payout_id', payoutId).order('created_at', { ascending: false }),
    admin.from('email_deliveries').select('id, event_type, status, recipient_user_id, created_at').eq('related_entity_type', 'merchant_payout').eq('related_entity_id', payoutId).order('created_at', { ascending: false }),
  ])

  let listingTitle: string | null = null
  let disputes: Record<string, unknown>[] = []
  if (booking) {
    const [{ data: listing }, { data: disputeRows }] = await Promise.all([
      admin.from('listings').select('title').eq('id', booking.listing_id).maybeSingle(),
      admin.from('disputes').select('*').eq('booking_id', booking.id).order('created_at', { ascending: false }),
    ])
    listingTitle = listing?.title ?? null
    disputes = disputeRows ?? []
  }

  const rentalPayment = (payments ?? []).find((p) => p.payment_type === 'rental_charge') ?? null
  const depositPayment = (payments ?? []).find((p) => p.payment_type === 'deposit') ?? null

  return {
    payout,
    merchantName: merchant?.full_name ?? merchant?.display_name ?? null,
    merchantAccountStatus: merchant?.account_status ?? null,
    booking: booking ?? null,
    listingTitle,
    rentalPayment,
    depositPayment,
    disputes,
    history: history ?? [],
    emailDeliveries: emailDeliveries ?? [],
  }
}

const PAYOUT_CSV_COLUMNS: (keyof AdminPayoutRow)[] = [
  'id',
  'payoutReference',
  'merchantName',
  'bookingReference',
  'listingTitle',
  'amount',
  'currency',
  'status',
  'attemptCount',
  'createdAt',
  'processingStartedAt',
  'paidAt',
  'failedAt',
  'failureCategory',
]

export const ADMIN_PAYOUT_CSV_COLUMNS = PAYOUT_CSV_COLUMNS

export interface RealPayoutOverviewCounts {
  merchantPayoutsPending: number
  merchantPayoutsProcessing: number
  merchantPayoutsFailed: number
  merchantPayoutsPendingOverdue: number
  merchantPayoutsProcessingOverdue: number
}

/**
 * D3-E: the 5 payout-derived Admin Overview metrics, scoped to
 * confirmed real payouts only -- the exact same rule getAdminPayoutDetail
 * applies (merchant real, and the COMPLETE booking rule when
 * booking_id is set, never merchant-real alone). Deliberately does NOT
 * call _admin_list_merchant_payouts (the RPC blocker noted above) --
 * this is an independent, direct scoped query against
 * merchant_payouts/profiles/bookings/listings. booking_id is nullable,
 * so this cannot be a single embedded-join filter (an inner join on
 * bookings would wrongly exclude every payout with no booking at all)
 * -- rows are fetched per status, classified in batch (never per-row),
 * then counted. Preserves every existing status/timestamp definition
 * from get_admin_overview_stats() verbatim.
 */
export async function getRealPayoutOverviewCounts(admin: SupabaseClient): Promise<RealPayoutOverviewCounts> {
  const overdueThreshold = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()

  async function countRealForStatus(status: string, overdueColumn?: 'created_at' | 'processing_started_at'): Promise<number> {
    const query = admin.from('merchant_payouts').select('id, merchant_id, booking_id, created_at, processing_started_at').eq('status', status)
    const { data: rows } = await (overdueColumn ? query.lt(overdueColumn, overdueThreshold) : query)
    if (!rows || rows.length === 0) return 0

    const merchantIds = Array.from(new Set(rows.map((r) => r.merchant_id)))
    const bookingIds = Array.from(new Set(rows.filter((r) => r.booking_id).map((r) => r.booking_id as string)))

    const [{ data: merchants }, { data: bookings }] = await Promise.all([
      admin.from('profiles').select('id, data_classification').in('id', merchantIds),
      bookingIds.length ? admin.from('bookings').select('id, renter_id, listing_id').in('id', bookingIds) : Promise.resolve({ data: [] }),
    ])
    const merchantById = new Map((merchants ?? []).map((m) => [m.id, { data_classification: m.data_classification }]))
    const bookingById = new Map((bookings ?? []).map((b) => [b.id, b]))

    const renterIds = Array.from(new Set((bookings ?? []).map((b) => b.renter_id)))
    const listingIds = Array.from(new Set((bookings ?? []).map((b) => b.listing_id)))
    const [{ data: renters }, { data: listings }] = await Promise.all([
      renterIds.length ? admin.from('profiles').select('id, data_classification').in('id', renterIds) : Promise.resolve({ data: [] }),
      listingIds.length ? admin.from('listings').select('id, is_test').in('id', listingIds) : Promise.resolve({ data: [] }),
    ])
    const renterById = new Map((renters ?? []).map((r) => [r.id, { data_classification: r.data_classification }]))
    const listingIsTestById = new Map((listings ?? []).map((l) => [l.id, l.is_test]))

    return rows.filter((r) => {
      const merchant = merchantById.get(r.merchant_id) ?? {}
      if (!r.booking_id) return classifyEntityWithOwners({ is_test: false }, [merchant]) === 'real'
      const booking = bookingById.get(r.booking_id)
      if (!booking) return false
      const renter = renterById.get(booking.renter_id) ?? {}
      const isTest = listingIsTestById.get(booking.listing_id) === true
      return classifyEntityWithOwners({ is_test: isTest }, [renter, merchant]) === 'real'
    }).length
  }

  const [merchantPayoutsPending, merchantPayoutsProcessing, merchantPayoutsFailed, merchantPayoutsPendingOverdue, merchantPayoutsProcessingOverdue] =
    await Promise.all([
      countRealForStatus('pending'),
      countRealForStatus('processing'),
      countRealForStatus('failed'),
      countRealForStatus('pending', 'created_at'),
      countRealForStatus('processing', 'processing_started_at'),
    ])

  return {
    merchantPayoutsPending,
    merchantPayoutsProcessing,
    merchantPayoutsFailed,
    merchantPayoutsPendingOverdue,
    merchantPayoutsProcessingOverdue,
  }
}

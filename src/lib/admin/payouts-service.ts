import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 100

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

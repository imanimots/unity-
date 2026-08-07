import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 100
const OVERDUE_HOURS = 48

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

/** Mirrors listAdminAffiliateCommissions' exact shape: one base query + Promise.all of related-table lookups + in-memory joins. */
export async function listAdminPayouts(admin: SupabaseClient, filters: AdminPayoutFilters): Promise<AdminPayoutRow[]> {
  let query = admin
    .from('merchant_payouts')
    .select('id, merchant_id, booking_id, amount, status, provider_reference, created_at, processing_started_at, paid_at, failed_at, failure_category, attempt_count')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)
  if (filters.failedOnly) query = query.eq('status', 'failed')
  if (filters.dateFrom) query = query.gte('created_at', filters.dateFrom)
  if (filters.dateTo) query = query.lte('created_at', filters.dateTo)

  const { data: rows, error } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const merchantIds = Array.from(new Set(rows.map((r) => r.merchant_id)))
  const bookingIds = rows.map((r) => r.booking_id).filter((id): id is string => !!id)

  const [{ data: profiles }, { data: bookings }] = await Promise.all([
    admin.from('profiles').select('id, full_name, display_name, account_status').in('id', merchantIds),
    admin.from('bookings').select('id, booking_reference, listing_id').in('id', bookingIds),
  ])

  const listingIds = Array.from(new Set((bookings ?? []).map((b) => b.listing_id)))
  const { data: listings } = await admin.from('listings').select('id, title').in('id', listingIds)

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))
  const restrictedById = new Map((profiles ?? []).map((p) => [p.id, p.account_status === 'suspended' || p.account_status === 'restricted']))
  const bookingById = new Map((bookings ?? []).map((b) => [b.id, b]))
  const listingTitleById = new Map((listings ?? []).map((l) => [l.id, l.title]))

  const { data: disputes } = bookingIds.length
    ? await admin.from('disputes').select('booking_id, status').in('booking_id', bookingIds).not('status', 'in', '(resolved,closed,cancelled)')
    : { data: [] }
  const disputedBookingIds = new Set((disputes ?? []).map((d) => d.booking_id))

  const overdueThreshold = new Date(Date.now() - OVERDUE_HOURS * 60 * 60 * 1000).toISOString()

  const overdueById = new Map<string, boolean>()
  let results: AdminPayoutRow[] = rows.map((r) => {
    const booking = r.booking_id ? bookingById.get(r.booking_id) : null
    const isOverduePending = r.status === 'pending' && r.created_at < overdueThreshold
    const isOverdueProcessing = r.status === 'processing' && !!r.processing_started_at && r.processing_started_at < overdueThreshold
    overdueById.set(r.id, isOverduePending || isOverdueProcessing)
    return {
      id: r.id,
      payoutReference: r.provider_reference,
      merchantId: r.merchant_id,
      merchantName: nameById.get(r.merchant_id) ?? null,
      bookingId: r.booking_id,
      bookingReference: booking?.booking_reference ?? null,
      listingTitle: booking ? (listingTitleById.get(booking.listing_id) ?? null) : null,
      amount: r.amount,
      currency: 'ZAR',
      status: r.status,
      createdAt: r.created_at,
      processingStartedAt: r.processing_started_at,
      paidAt: r.paid_at,
      failedAt: r.failed_at,
      failureCategory: r.failure_category,
      attemptCount: r.attempt_count,
      hasUnresolvedDispute: r.booking_id ? disputedBookingIds.has(r.booking_id) : false,
      merchantRestricted: restrictedById.get(r.merchant_id) ?? false,
    }
  })

  if (filters.overdueOnly) {
    results = results.filter((r) => overdueById.get(r.id))
  }
  if (filters.disputeRelated) {
    results = results.filter((r) => r.hasUnresolvedDispute)
  }
  if (filters.restrictedMerchant) {
    results = results.filter((r) => r.merchantRestricted)
  }
  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase()
    results = results.filter(
      (r) =>
        (r.payoutReference ?? '').toLowerCase().includes(q) ||
        (r.merchantName ?? '').toLowerCase().includes(q) ||
        (r.bookingReference ?? '').toLowerCase().includes(q) ||
        (r.listingTitle ?? '').toLowerCase().includes(q)
    )
  }

  return results
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

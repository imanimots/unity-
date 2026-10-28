import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyEntityWithOwners, type ProfileDataClassification } from '@/lib/admin/data-scope'

const DEFAULT_LIMIT = 100

/**
 * D3-E: a unity_commissions row is not real merely because it exists --
 * it inherits provenance from its originating transaction (exactly one
 * of order_id/booking_id, per unity_commissions_one_transaction_chk),
 * reusing that transaction's own already-established rule (orders:
 * buyer+seller+listing.is_test; bookings: renter+merchant+listing.is_test)
 * -- never a commission-specific reimplementation. The commission's own
 * merchant_id/listing_id are the seller/listing side of that same
 * transaction, so checking the transaction directly covers both without
 * duplicating logic.
 */
async function resolveUnityCommissionRealClassification(
  admin: SupabaseClient,
  commission: { order_id: string | null; booking_id: string | null }
): Promise<ProfileDataClassification> {
  if (commission.order_id) {
    const { data: order } = await admin.from('orders').select('buyer_id, seller_id, listing_id').eq('id', commission.order_id).maybeSingle()
    if (!order) return 'unknown'
    const [{ data: profiles }, { data: listing }] = await Promise.all([
      admin.from('profiles').select('id, data_classification').in('id', [order.buyer_id, order.seller_id]),
      admin.from('listings').select('is_test').eq('id', order.listing_id).maybeSingle(),
    ])
    const buyer = profiles?.find((p) => p.id === order.buyer_id)
    const seller = profiles?.find((p) => p.id === order.seller_id)
    return classifyEntityWithOwners({ is_test: listing?.is_test === true }, [buyer ?? {}, seller ?? {}])
  }
  if (commission.booking_id) {
    const { data: booking } = await admin.from('bookings').select('renter_id, merchant_id, listing_id').eq('id', commission.booking_id).maybeSingle()
    if (!booking) return 'unknown'
    const [{ data: profiles }, { data: listing }] = await Promise.all([
      admin.from('profiles').select('id, data_classification').in('id', [booking.renter_id, booking.merchant_id]),
      admin.from('listings').select('is_test').eq('id', booking.listing_id).maybeSingle(),
    ])
    const renter = profiles?.find((p) => p.id === booking.renter_id)
    const merchant = profiles?.find((p) => p.id === booking.merchant_id)
    return classifyEntityWithOwners({ is_test: listing?.is_test === true }, [renter ?? {}, merchant ?? {}])
  }
  // unity_commissions_one_transaction_chk enforces exactly one of
  // order_id/booking_id -- reaching here should never happen. Fail
  // safe, never guess real.
  return 'unknown'
}

export interface AdminUnityCommissionRow {
  id: string
  transactionType: string
  status: string
  merchantId: string
  merchantName: string | null
  listingId: string
  listingTitle: string | null
  reference: string | null
  merchantPlanId: string
  eligibleBase: number
  standardRateBps: number
  excessRateBps: number
  excessBase: number
  commissionAmount: number
  currency: string
  createdAt: string
  earnedAt: string | null
  hasRefundOrDispute: boolean
}

export interface AdminUnityCommissionFilters {
  merchantId?: string
  listingId?: string
  transactionType?: string
  status?: string
  search?: string
  limit?: number
}

/**
 * Mirrors listAdminAffiliateCommissions' exact shape: one base query +
 * Promise.all of related-table lookups + in-memory joins.
 *
 * D3-E: real-data provenance here is inherited from the originating
 * order/booking (same rule as resolveUnityCommissionRealClassification,
 * inlined here as a batched classification instead -- never a per-row
 * query), which PostgREST cannot express as a single embedded-join
 * filter on `unity_commissions` itself (exactly one of two different
 * parent tables). Like Disputes/Reviews (D3-D), the row-count bound
 * moves to AFTER classification, never before it -- the initial query
 * still applies merchantId/listingId/transactionType/status filters at
 * the DB level, just without `.limit()`.
 */
export async function listAdminUnityCommissions(admin: SupabaseClient, filters: AdminUnityCommissionFilters): Promise<AdminUnityCommissionRow[]> {
  let query = admin
    .from('unity_commissions')
    .select(
      'id, transaction_type, status, merchant_id, listing_id, order_id, booking_id, payment_id, merchant_plan_id, eligible_base, standard_rate_bps, excess_rate_bps, excess_base, commission_amount, currency, created_at, earned_at, listings(title)'
    )
    .order('created_at', { ascending: false })

  if (filters.merchantId) query = query.eq('merchant_id', filters.merchantId)
  if (filters.listingId) query = query.eq('listing_id', filters.listingId)
  if (filters.transactionType && filters.transactionType !== 'all') query = query.eq('transaction_type', filters.transactionType)
  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)

  const { data: initialRows, error } = await query
  if (error) throw error
  if (!initialRows || initialRows.length === 0) return []

  const orderIds = initialRows.filter((r) => r.order_id).map((r) => r.order_id as string)
  const bookingIds = initialRows.filter((r) => r.booking_id).map((r) => r.booking_id as string)

  const [{ data: orders }, { data: bookings }] = await Promise.all([
    orderIds.length ? admin.from('orders').select('id, buyer_id, seller_id, listing_id').in('id', orderIds) : Promise.resolve({ data: [] }),
    bookingIds.length ? admin.from('bookings').select('id, renter_id, merchant_id, listing_id').in('id', bookingIds) : Promise.resolve({ data: [] }),
  ])
  const orderById = new Map((orders ?? []).map((o) => [o.id, o]))
  const bookingById = new Map((bookings ?? []).map((b) => [b.id, b]))

  const participantIds = new Set<string>()
  const listingIdsToCheck = new Set<string>()
  for (const o of orders ?? []) {
    participantIds.add(o.buyer_id)
    participantIds.add(o.seller_id)
    listingIdsToCheck.add(o.listing_id)
  }
  for (const b of bookings ?? []) {
    participantIds.add(b.renter_id)
    participantIds.add(b.merchant_id)
    listingIdsToCheck.add(b.listing_id)
  }

  const [{ data: scopeProfiles }, { data: scopeListings }] = await Promise.all([
    participantIds.size ? admin.from('profiles').select('id, data_classification').in('id', [...participantIds]) : Promise.resolve({ data: [] }),
    listingIdsToCheck.size ? admin.from('listings').select('id, is_test').in('id', [...listingIdsToCheck]) : Promise.resolve({ data: [] }),
  ])
  const scopeProfileById = new Map((scopeProfiles ?? []).map((p) => [p.id, { data_classification: p.data_classification }]))
  const listingIsTestById = new Map((scopeListings ?? []).map((l) => [l.id, l.is_test]))

  const rows = initialRows
    .filter((r) => {
      if (r.order_id) {
        const order = orderById.get(r.order_id)
        if (!order) return false
        const buyer = scopeProfileById.get(order.buyer_id) ?? {}
        const seller = scopeProfileById.get(order.seller_id) ?? {}
        const isTest = listingIsTestById.get(order.listing_id) === true
        return classifyEntityWithOwners({ is_test: isTest }, [buyer, seller]) === 'real'
      }
      if (r.booking_id) {
        const booking = bookingById.get(r.booking_id)
        if (!booking) return false
        const renter = scopeProfileById.get(booking.renter_id) ?? {}
        const merchant = scopeProfileById.get(booking.merchant_id) ?? {}
        const isTest = listingIsTestById.get(booking.listing_id) === true
        return classifyEntityWithOwners({ is_test: isTest }, [renter, merchant]) === 'real'
      }
      return false
    })
    .slice(0, filters.limit ?? DEFAULT_LIMIT)
  if (rows.length === 0) return []

  const merchantIds = Array.from(new Set(rows.map((r) => r.merchant_id)))
  const paymentIds = rows.map((r) => r.payment_id)

  const [{ data: profiles }, { data: payments }] = await Promise.all([
    admin.from('profiles').select('id, full_name, display_name').in('id', merchantIds),
    admin.from('payments').select('id, status').in('id', paymentIds),
  ])

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))
  const paymentStatusById = new Map((payments ?? []).map((p) => [p.id, p.status]))

  let results: AdminUnityCommissionRow[] = rows.map((r) => ({
    id: r.id,
    transactionType: r.transaction_type,
    status: r.status,
    merchantId: r.merchant_id,
    merchantName: nameById.get(r.merchant_id) ?? null,
    listingId: r.listing_id,
    listingTitle: (r.listings as unknown as { title: string } | null)?.title ?? null,
    reference: r.order_id ?? r.booking_id,
    merchantPlanId: r.merchant_plan_id,
    eligibleBase: r.eligible_base,
    standardRateBps: r.standard_rate_bps,
    excessRateBps: r.excess_rate_bps,
    excessBase: r.excess_base,
    commissionAmount: r.commission_amount,
    currency: r.currency,
    createdAt: r.created_at,
    earnedAt: r.earned_at,
    hasRefundOrDispute: ['refunded', 'partially_refunded', 'chargeback'].includes(paymentStatusById.get(r.payment_id) ?? ''),
  }))

  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase()
    results = results.filter(
      (c) => (c.merchantName ?? '').toLowerCase().includes(q) || (c.listingTitle ?? '').toLowerCase().includes(q) || (c.reference ?? '').toLowerCase().includes(q)
    )
  }

  return results
}

export interface AdminUnityCommissionDetail {
  commission: Record<string, unknown>
  history: Record<string, unknown>[]
  adjustments: Record<string, unknown>[]
  payment: Record<string, unknown> | null
  merchantName: string | null
  listingTitle: string | null
}

export async function getAdminUnityCommissionDetail(admin: SupabaseClient, commissionId: string): Promise<AdminUnityCommissionDetail | null> {
  const { data: commission, error } = await admin.from('unity_commissions').select('*').eq('id', commissionId).maybeSingle()
  if (error) throw error
  if (!commission) return null

  // D3-E: a known test/unknown-linked commission id must not load as
  // an ordinary Real Data detail -- checked before history/adjustments/
  // payment/profile/listing fetches below.
  if ((await resolveUnityCommissionRealClassification(admin, commission)) !== 'real') return null

  const [{ data: history }, { data: adjustments }, { data: payment }, { data: merchantProfile }, { data: listing }] = await Promise.all([
    admin.from('unity_commission_history').select('*').eq('commission_id', commissionId).order('created_at', { ascending: false }),
    admin.from('unity_commission_adjustments').select('*').eq('commission_id', commissionId).order('created_at', { ascending: false }),
    admin.from('payments').select('id, status, amount, currency, provider, captured_at').eq('id', commission.payment_id).maybeSingle(),
    admin.from('profiles').select('id, full_name, display_name').eq('id', commission.merchant_id).maybeSingle(),
    admin.from('listings').select('title').eq('id', commission.listing_id).maybeSingle(),
  ])

  return {
    commission,
    history: history ?? [],
    adjustments: adjustments ?? [],
    payment: payment ?? null,
    merchantName: merchantProfile?.full_name ?? merchantProfile?.display_name ?? null,
    listingTitle: listing?.title ?? null,
  }
}

const COMMISSION_CSV_COLUMNS: (keyof AdminUnityCommissionRow)[] = [
  'id',
  'transactionType',
  'merchantName',
  'listingTitle',
  'reference',
  'merchantPlanId',
  'eligibleBase',
  'commissionAmount',
  'currency',
  'status',
  'createdAt',
  'earnedAt',
]

export const UNITY_COMMISSION_CSV_COLUMNS = COMMISSION_CSV_COLUMNS

export interface RealUnityCommissionOverviewCounts {
  unityCommissionsPending: number
  unityCommissionsHeld: number
  unityCommissionsEarned: number
  unityCommissionsVoided: number
  unityCommissionsHighValueSales: number
}

/**
 * D3-E: the 5 unity-commission-derived Admin Overview metrics, scoped
 * to confirmed real commissions only -- the exact same rule
 * listAdminUnityCommissions/resolveUnityCommissionRealClassification
 * already apply. Preserves every existing status/transaction_type/
 * excess_base definition from get_admin_overview_stats() verbatim.
 *
 * P3 scalability note (same disposition as D3-D's Disputes/Reviews):
 * classification is resolved per matching row rather than via a single
 * DB-level count, since PostgREST cannot express "whichever of
 * order_id/booking_id is set" as one embedded-join filter. Acceptable
 * at current commission volume; revisit if volume grows substantially.
 */
export async function getRealUnityCommissionOverviewCounts(admin: SupabaseClient): Promise<RealUnityCommissionOverviewCounts> {
  async function countReal(filter: (q: ReturnType<typeof baseQuery>) => typeof q): Promise<number> {
    const { data: rows } = await filter(baseQuery())
    if (!rows || rows.length === 0) return 0
    const classifications = await Promise.all(rows.map((r) => resolveUnityCommissionRealClassification(admin, r)))
    return classifications.filter((c) => c === 'real').length
  }
  function baseQuery() {
    return admin.from('unity_commissions').select('order_id, booking_id, transaction_type, excess_base')
  }

  const [unityCommissionsPending, unityCommissionsHeld, unityCommissionsEarned, unityCommissionsVoided, unityCommissionsHighValueSales] =
    await Promise.all([
      countReal((q) => q.eq('status', 'pending')),
      countReal((q) => q.eq('status', 'held')),
      countReal((q) => q.eq('status', 'earned')),
      countReal((q) => q.eq('status', 'voided')),
      countReal((q) => q.eq('transaction_type', 'sale').gt('excess_base', 0)),
    ])

  return {
    unityCommissionsPending,
    unityCommissionsHeld,
    unityCommissionsEarned,
    unityCommissionsVoided,
    unityCommissionsHighValueSales,
  }
}

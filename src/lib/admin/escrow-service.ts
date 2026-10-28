import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyEntityWithOwners, type ProfileDataClassification } from '@/lib/admin/data-scope'

const DEFAULT_LIMIT = 100

/**
 * D3-E: escrow_transactions has no participants of its own -- its
 * real-data provenance is inherited from whichever ONE of its three
 * nullable parent-transaction columns is set (order/booking/barter --
 * confirmed from supabase/migrations/20260825000001_escrow_schema.sql:
 * no rent_to_buy_agreement_id column and no is_test column exist on
 * this table). Each parent's rule reuses the exact same positive-proof
 * logic already applied to that parent's own list/detail (orders:
 * buyer+seller+listing.is_test; bookings: renter+merchant+listing.is_test;
 * barter: party_a+party_b) -- never an escrow-specific reimplementation.
 */
async function resolveEscrowRealClassification(
  admin: SupabaseClient,
  escrow: { order_id: string | null; booking_id: string | null; barter_agreement_id: string | null }
): Promise<ProfileDataClassification> {
  if (escrow.order_id) {
    const { data: order } = await admin.from('orders').select('buyer_id, seller_id, listing_id').eq('id', escrow.order_id).maybeSingle()
    if (!order) return 'unknown'
    const [{ data: profiles }, { data: listing }] = await Promise.all([
      admin.from('profiles').select('id, data_classification').in('id', [order.buyer_id, order.seller_id]),
      admin.from('listings').select('is_test').eq('id', order.listing_id).maybeSingle(),
    ])
    const buyer = profiles?.find((p) => p.id === order.buyer_id)
    const seller = profiles?.find((p) => p.id === order.seller_id)
    return classifyEntityWithOwners({ is_test: listing?.is_test === true }, [buyer ?? {}, seller ?? {}])
  }
  if (escrow.booking_id) {
    const { data: booking } = await admin.from('bookings').select('renter_id, merchant_id, listing_id').eq('id', escrow.booking_id).maybeSingle()
    if (!booking) return 'unknown'
    const [{ data: profiles }, { data: listing }] = await Promise.all([
      admin.from('profiles').select('id, data_classification').in('id', [booking.renter_id, booking.merchant_id]),
      admin.from('listings').select('is_test').eq('id', booking.listing_id).maybeSingle(),
    ])
    const renter = profiles?.find((p) => p.id === booking.renter_id)
    const merchant = profiles?.find((p) => p.id === booking.merchant_id)
    return classifyEntityWithOwners({ is_test: listing?.is_test === true }, [renter ?? {}, merchant ?? {}])
  }
  if (escrow.barter_agreement_id) {
    const { data: agreement } = await admin.from('barter_agreements').select('party_a_id, party_b_id').eq('id', escrow.barter_agreement_id).maybeSingle()
    if (!agreement) return 'unknown'
    const { data: profiles } = await admin.from('profiles').select('id, data_classification').in('id', [agreement.party_a_id, agreement.party_b_id])
    const partyA = profiles?.find((p) => p.id === agreement.party_a_id)
    const partyB = profiles?.find((p) => p.id === agreement.party_b_id)
    return classifyEntityWithOwners({ is_test: false }, [partyA ?? {}, partyB ?? {}])
  }
  // Exactly one of order_id/booking_id/barter_agreement_id should
  // always be set -- reaching here should never happen. Fail safe,
  // never guess real.
  return 'unknown'
}

export interface AdminEscrowRow {
  id: string
  transactionType: string
  status: string
  provider: string
  principalAmount: number
  secureTransactionFeeAmount: number
  currency: string
  orderId: string | null
  bookingId: string | null
  barterAgreementId: string | null
  transactionReference: string | null
  createdAt: string
  fundedAt: string | null
  releasedAt: string | null
  refundedAt: string | null
  hasUnresolvedDispute: boolean
}

export interface AdminEscrowFilters {
  search?: string
  status?: string
  limit?: number
}

/**
 * Mirrors listAdminPayouts' exact shape -- one base query + Promise.all
 * of related-table lookups + in-memory joins.
 *
 * D3-E: real-data provenance is inherited from whichever parent
 * transaction is linked (see resolveEscrowRealClassification's own
 * comment), which PostgREST cannot express as a single embedded-join
 * filter on `escrow_transactions` itself (exactly one of three
 * different parent tables). Like Disputes/Reviews (D3-D), the
 * row-count bound moves to AFTER classification, never before it.
 */
export async function listAdminEscrowTransactions(admin: SupabaseClient, filters: AdminEscrowFilters): Promise<AdminEscrowRow[]> {
  let query = admin
    .from('escrow_transactions')
    .select('id, transaction_type, status, provider, principal_amount, secure_transaction_fee_amount, currency, order_id, booking_id, barter_agreement_id, created_at, funded_at, released_at, refunded_at')
    .order('created_at', { ascending: false })

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)

  const { data: initialRows, error } = await query
  if (error) throw error
  if (!initialRows || initialRows.length === 0) return []

  const orderIds = initialRows.map((r) => r.order_id).filter((id): id is string => !!id)
  const bookingIds = initialRows.map((r) => r.booking_id).filter((id): id is string => !!id)
  const barterIds = initialRows.map((r) => r.barter_agreement_id).filter((id): id is string => !!id)

  const [{ data: orders }, { data: bookings }, { data: barterAgreements }] = await Promise.all([
    orderIds.length ? admin.from('orders').select('id, order_reference, buyer_id, seller_id, listing_id').in('id', orderIds) : Promise.resolve({ data: [] }),
    bookingIds.length
      ? admin.from('bookings').select('id, booking_reference, renter_id, merchant_id, listing_id').in('id', bookingIds)
      : Promise.resolve({ data: [] }),
    barterIds.length ? admin.from('barter_agreements').select('id, agreement_reference, party_a_id, party_b_id').in('id', barterIds) : Promise.resolve({ data: [] }),
  ])

  const orderRefById = new Map((orders ?? []).map((o) => [o.id, o.order_reference]))
  const bookingRefById = new Map((bookings ?? []).map((b) => [b.id, b.booking_reference]))
  const barterRefById = new Map((barterAgreements ?? []).map((b) => [b.id, b.agreement_reference]))
  const orderById = new Map((orders ?? []).map((o) => [o.id, o]))
  const bookingById = new Map((bookings ?? []).map((b) => [b.id, b]))
  const barterById = new Map((barterAgreements ?? []).map((b) => [b.id, b]))

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
  for (const b of barterAgreements ?? []) {
    participantIds.add(b.party_a_id)
    participantIds.add(b.party_b_id)
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
      if (r.barter_agreement_id) {
        const agreement = barterById.get(r.barter_agreement_id)
        if (!agreement) return false
        const partyA = scopeProfileById.get(agreement.party_a_id) ?? {}
        const partyB = scopeProfileById.get(agreement.party_b_id) ?? {}
        return classifyEntityWithOwners({ is_test: false }, [partyA, partyB]) === 'real'
      }
      return false
    })
    .slice(0, filters.limit ?? DEFAULT_LIMIT)
  if (rows.length === 0) return []

  const [{ data: orderDisputes }, { data: bookingDisputes }, { data: barterDisputes }] = await Promise.all([
    orderIds.length ? admin.from('disputes').select('order_id').in('order_id', orderIds).not('status', 'in', '(resolved,closed,cancelled)') : Promise.resolve({ data: [] }),
    bookingIds.length ? admin.from('disputes').select('booking_id').in('booking_id', bookingIds).not('status', 'in', '(resolved,closed,cancelled)') : Promise.resolve({ data: [] }),
    barterIds.length ? admin.from('disputes').select('barter_agreement_id').in('barter_agreement_id', barterIds).not('status', 'in', '(resolved,closed,cancelled)') : Promise.resolve({ data: [] }),
  ])
  const disputedOrderIds = new Set((orderDisputes ?? []).map((d) => d.order_id))
  const disputedBookingIds = new Set((bookingDisputes ?? []).map((d) => d.booking_id))
  const disputedBarterIds = new Set((barterDisputes ?? []).map((d) => d.barter_agreement_id))

  let results: AdminEscrowRow[] = rows.map((r) => ({
    id: r.id,
    transactionType: r.transaction_type,
    status: r.status,
    provider: r.provider,
    principalAmount: r.principal_amount,
    secureTransactionFeeAmount: r.secure_transaction_fee_amount,
    currency: r.currency,
    orderId: r.order_id,
    bookingId: r.booking_id,
    barterAgreementId: r.barter_agreement_id,
    transactionReference: r.order_id
      ? (orderRefById.get(r.order_id) ?? null)
      : r.booking_id
        ? (bookingRefById.get(r.booking_id) ?? null)
        : r.barter_agreement_id
          ? (barterRefById.get(r.barter_agreement_id) ?? null)
          : null,
    createdAt: r.created_at,
    fundedAt: r.funded_at,
    releasedAt: r.released_at,
    refundedAt: r.refunded_at,
    hasUnresolvedDispute: r.order_id
      ? disputedOrderIds.has(r.order_id)
      : r.booking_id
        ? disputedBookingIds.has(r.booking_id)
        : r.barter_agreement_id
          ? disputedBarterIds.has(r.barter_agreement_id)
          : false,
  }))

  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase()
    results = results.filter((r) => (r.transactionReference ?? '').toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
  }

  return results
}

export interface AdminEscrowDetail {
  escrow: Record<string, unknown>
  transactionReference: string | null
  disputes: Record<string, unknown>[]
  history: Record<string, unknown>[]
}

export async function getAdminEscrowDetail(admin: SupabaseClient, escrowId: string): Promise<AdminEscrowDetail | null> {
  const { data: escrow, error } = await admin.from('escrow_transactions').select('*').eq('id', escrowId).maybeSingle()
  if (error) throw error
  if (!escrow) return null

  // D3-E: a known test/unknown-linked escrow id must not load as an
  // ordinary Real Data detail -- checked before the parent-transaction/
  // dispute fetches below.
  if ((await resolveEscrowRealClassification(admin, escrow)) !== 'real') return null

  let transactionReference: string | null = null
  let disputes: Record<string, unknown>[] = []
  if (escrow.order_id) {
    const [{ data: order }, { data: disputeRows }] = await Promise.all([
      admin.from('orders').select('order_reference').eq('id', escrow.order_id).maybeSingle(),
      admin.from('disputes').select('*').eq('order_id', escrow.order_id).order('created_at', { ascending: false }),
    ])
    transactionReference = order?.order_reference ?? null
    disputes = disputeRows ?? []
  } else if (escrow.booking_id) {
    const [{ data: booking }, { data: disputeRows }] = await Promise.all([
      admin.from('bookings').select('booking_reference').eq('id', escrow.booking_id).maybeSingle(),
      admin.from('disputes').select('*').eq('booking_id', escrow.booking_id).order('created_at', { ascending: false }),
    ])
    transactionReference = booking?.booking_reference ?? null
    disputes = disputeRows ?? []
  } else if (escrow.barter_agreement_id) {
    const [{ data: agreement }, { data: disputeRows }] = await Promise.all([
      admin.from('barter_agreements').select('agreement_reference').eq('id', escrow.barter_agreement_id).maybeSingle(),
      admin.from('disputes').select('*').eq('barter_agreement_id', escrow.barter_agreement_id).order('created_at', { ascending: false }),
    ])
    transactionReference = agreement?.agreement_reference ?? null
    disputes = disputeRows ?? []
  }

  const { data: history } = await admin.from('escrow_transaction_history').select('*').eq('escrow_transaction_id', escrowId).order('created_at', { ascending: false })

  return { escrow, transactionReference, disputes, history: history ?? [] }
}

const ESCROW_CSV_COLUMNS: (keyof AdminEscrowRow)[] = [
  'id',
  'transactionType',
  'status',
  'provider',
  'principalAmount',
  'secureTransactionFeeAmount',
  'currency',
  'transactionReference',
  'createdAt',
  'fundedAt',
  'releasedAt',
  'refundedAt',
]

export const ADMIN_ESCROW_CSV_COLUMNS = ESCROW_CSV_COLUMNS

export interface RealEscrowOverviewCounts {
  escrowTransactionsPending: number
  escrowTransactionsFunded: number
  escrowTransactionsReleased: number
  escrowTransactionsRefunded: number
  escrowTransactionsFailed: number
}

/**
 * D3-E: the 5 escrow-derived Admin Overview metrics, scoped to
 * confirmed real escrow transactions only -- the exact same rule
 * resolveEscrowRealClassification already applies. Preserves every
 * existing status grouping from get_admin_overview_stats() verbatim.
 *
 * P3 scalability note (same disposition as D3-D's Disputes/Reviews):
 * classification is resolved per matching row rather than via a single
 * DB-level count, since PostgREST cannot express "whichever of
 * order_id/booking_id/barter_agreement_id is set" as one embedded-join
 * filter. Acceptable at current escrow volume; revisit if volume grows
 * substantially.
 */
export async function getRealEscrowOverviewCounts(admin: SupabaseClient): Promise<RealEscrowOverviewCounts> {
  async function countRealForStatuses(statuses: string[]): Promise<number> {
    const { data: rows } = await admin.from('escrow_transactions').select('order_id, booking_id, barter_agreement_id').in('status', statuses)
    if (!rows || rows.length === 0) return 0
    const classifications = await Promise.all(rows.map((r) => resolveEscrowRealClassification(admin, r)))
    return classifications.filter((c) => c === 'real').length
  }

  const [escrowTransactionsPending, escrowTransactionsFunded, escrowTransactionsReleased, escrowTransactionsRefunded, escrowTransactionsFailed] =
    await Promise.all([
      countRealForStatuses(['pending']),
      countRealForStatuses(['funded']),
      countRealForStatuses(['released']),
      countRealForStatuses(['refunded', 'partially_refunded']),
      countRealForStatuses(['failed']),
    ])

  return {
    escrowTransactionsPending,
    escrowTransactionsFunded,
    escrowTransactionsReleased,
    escrowTransactionsRefunded,
    escrowTransactionsFailed,
  }
}

import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 100

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

/** Mirrors listAdminPayouts' exact shape -- one base query + Promise.all of related-table lookups + in-memory joins. */
export async function listAdminEscrowTransactions(admin: SupabaseClient, filters: AdminEscrowFilters): Promise<AdminEscrowRow[]> {
  let query = admin
    .from('escrow_transactions')
    .select('id, transaction_type, status, provider, principal_amount, secure_transaction_fee_amount, currency, order_id, booking_id, barter_agreement_id, created_at, funded_at, released_at, refunded_at')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)

  const { data: rows, error } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const orderIds = rows.map((r) => r.order_id).filter((id): id is string => !!id)
  const bookingIds = rows.map((r) => r.booking_id).filter((id): id is string => !!id)
  const barterIds = rows.map((r) => r.barter_agreement_id).filter((id): id is string => !!id)

  const [{ data: orders }, { data: bookings }, { data: barterAgreements }] = await Promise.all([
    orderIds.length ? admin.from('orders').select('id, order_reference').in('id', orderIds) : Promise.resolve({ data: [] }),
    bookingIds.length ? admin.from('bookings').select('id, booking_reference').in('id', bookingIds) : Promise.resolve({ data: [] }),
    barterIds.length ? admin.from('barter_agreements').select('id, agreement_reference').in('id', barterIds) : Promise.resolve({ data: [] }),
  ])

  const orderRefById = new Map((orders ?? []).map((o) => [o.id, o.order_reference]))
  const bookingRefById = new Map((bookings ?? []).map((b) => [b.id, b.booking_reference]))
  const barterRefById = new Map((barterAgreements ?? []).map((b) => [b.id, b.agreement_reference]))

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

import type { SupabaseClient } from '@supabase/supabase-js'

const DEFAULT_LIMIT = 100

export type OrderFinancialReadiness = 'awaiting_payment' | 'financially_ready' | 'payment_failed'

/**
 * Unlike bookings/barter, an order's own `status` already IS the
 * persisted financial signal (order_status has a real 'paid' value,
 * see 20260812000004_order_rpcs.sql's own header comment) -- there is no
 * separate readiness state to derive and keep in sync with an RPC the
 * way deriveFinancialReadiness()/deriveBarterFinancialReadiness() do.
 * This is a thin display label, not an enforcement input anywhere.
 */
export function deriveOrderFinancialReadiness(orderStatus: string, paymentStatus: string | null): OrderFinancialReadiness {
  if (orderStatus === 'pending' && paymentStatus === 'failed') return 'payment_failed'
  if (orderStatus === 'pending') return 'awaiting_payment'
  return 'financially_ready'
}

/** Listing-level capability hint only -- orders has no per-order chosen delivery method column (see docs/ORDER_ADMINISTRATION.md). */
export function deriveDeliveryMethodHint(listing: { shipping_payer: string | null; delivery_available: boolean | null; merchant_delivery_available: boolean | null } | null): string {
  if (!listing) return 'unknown'
  if (listing.merchant_delivery_available) return 'merchant delivery available'
  if (listing.delivery_available) return 'delivery available'
  return 'collection / shipping not specified'
}

export interface AdminOrderRow {
  id: string
  orderReference: string
  listingTitle: string | null
  buyerId: string
  buyerName: string | null
  sellerId: string
  sellerName: string | null
  status: string
  paymentStatus: string | null
  financialReadiness: OrderFinancialReadiness
  totalAmount: number
  currency: string
  deliveryMethodHint: string
  createdAt: string
  lastLifecycleEvent: string | null
  disputed: boolean
  hasEmailFailure: boolean
}

export interface AdminOrderFilters {
  status?: string
  paymentStatus?: string
  disputed?: boolean
  buyerId?: string
  sellerId?: string
  search?: string
  limit?: number
}

/**
 * Mirrors listAdminBarterAgreements/listAdminDisputes' exact shape: one
 * base query + Promise.all of related-table lookups + in-memory joins +
 * in-memory search filter, no separate "service class".
 */
export async function listAdminOrders(admin: SupabaseClient, filters: AdminOrderFilters): Promise<AdminOrderRow[]> {
  let query = admin
    .from('orders')
    .select('id, order_reference, listing_id, buyer_id, seller_id, status, total_amount, created_at')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)
  if (filters.buyerId) query = query.eq('buyer_id', filters.buyerId)
  if (filters.sellerId) query = query.eq('seller_id', filters.sellerId)

  const { data: rows, error } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const userIds = Array.from(new Set(rows.flatMap((r) => [r.buyer_id, r.seller_id])))
  const listingIds = Array.from(new Set(rows.map((r) => r.listing_id)))
  const orderIds = rows.map((r) => r.id)

  const [{ data: profiles }, { data: listings }, { data: payments }, { data: historyRows }, { data: disputeRows }, { data: emailRows }] = await Promise.all([
    admin.from('profiles').select('id, full_name, display_name').in('id', userIds),
    admin.from('listings').select('id, title, shipping_payer, delivery_available, merchant_delivery_available').in('id', listingIds),
    admin.from('payments').select('order_id, status').eq('payment_type', 'order_payment').in('order_id', orderIds),
    admin.from('order_history').select('order_id, event_type, created_at').in('order_id', orderIds).order('created_at', { ascending: false }),
    admin.from('disputes').select('order_id').in('order_id', orderIds),
    admin.from('email_deliveries').select('related_entity_id, status').eq('related_entity_type', 'order').in('related_entity_id', orderIds).in('status', ['failed_retryable', 'failed_terminal']),
  ])

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))
  const listingById = new Map((listings ?? []).map((l) => [l.id, l]))
  const paymentStatusByOrder = new Map((payments ?? []).map((p) => [p.order_id, p.status]))
  const disputedOrderIds = new Set((disputeRows ?? []).map((d) => d.order_id))
  const emailFailureOrderIds = new Set((emailRows ?? []).map((e) => e.related_entity_id))

  const latestEventByOrder = new Map<string, string>()
  for (const h of historyRows ?? []) {
    if (!latestEventByOrder.has(h.order_id)) latestEventByOrder.set(h.order_id, h.event_type)
  }

  let results: AdminOrderRow[] = rows.map((r) => {
    const listing = listingById.get(r.listing_id) ?? null
    const paymentStatus = paymentStatusByOrder.get(r.id) ?? null
    return {
      id: r.id,
      orderReference: r.order_reference,
      listingTitle: listing?.title ?? null,
      buyerId: r.buyer_id,
      buyerName: nameById.get(r.buyer_id) ?? null,
      sellerId: r.seller_id,
      sellerName: nameById.get(r.seller_id) ?? null,
      status: r.status,
      paymentStatus,
      financialReadiness: deriveOrderFinancialReadiness(r.status, paymentStatus),
      totalAmount: r.total_amount,
      currency: 'ZAR',
      deliveryMethodHint: deriveDeliveryMethodHint(listing),
      createdAt: r.created_at,
      lastLifecycleEvent: latestEventByOrder.get(r.id) ?? null,
      disputed: disputedOrderIds.has(r.id),
      hasEmailFailure: emailFailureOrderIds.has(r.id),
    }
  })

  if (filters.paymentStatus && filters.paymentStatus !== 'all') {
    results = results.filter((r) => r.paymentStatus === filters.paymentStatus)
  }
  if (filters.disputed !== undefined) {
    results = results.filter((r) => r.disputed === filters.disputed)
  }

  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase()
    results = results.filter(
      (o) =>
        o.orderReference.toLowerCase().includes(q) ||
        (o.listingTitle ?? '').toLowerCase().includes(q) ||
        (o.buyerName ?? '').toLowerCase().includes(q) ||
        (o.sellerName ?? '').toLowerCase().includes(q)
    )
  }

  return results
}

export interface AdminOrderDetail {
  order: {
    id: string
    orderReference: string
    listingId: string
    listingTitle: string | null
    buyerId: string
    sellerId: string
    status: string
    quantity: number
    unitPrice: number
    shippingFee: number
    totalAmount: number
    currency: string
    createdAt: string
    deliveryMethodHint: string
    lastLifecycleEvent: string | null
  }
  financial: {
    payment: Record<string, unknown> | null
    attempts: Record<string, unknown>[]
    events: Record<string, unknown>[]
    ledgerEntryCount: number
    payoutStatus: 'not_applicable'
  }
  history: Array<{ id: string; eventType: string; previousStatus: string | null; newStatus: string; actorRole: string | null; createdAt: string }>
  dispute: { id: string; status: string; title: string } | null
  emailDeliveries: Array<{ id: string; eventType: string; status: string; createdAt: string }>
  buyer: { id: string; name: string | null; accountStatus: string | null; kycStatus: string | null }
  seller: { id: string; name: string | null; accountStatus: string | null; kycStatus: string | null }
}

/**
 * Root `.maybeSingle()` + Promise.all of children, mirroring
 * getAdminBookingDetail's exact shape. `financial.payoutStatus` is
 * always the literal 'not_applicable' -- merchant_payouts has no
 * order_id/payment_id column at all, so it is never queried for an
 * order (see docs/ORDER_ADMINISTRATION.md).
 */
export async function getAdminOrderDetail(admin: SupabaseClient, orderId: string): Promise<AdminOrderDetail | null> {
  const { data: order, error } = await admin
    .from('orders')
    .select('id, order_reference, listing_id, buyer_id, seller_id, status, quantity, unit_price, shipping_fee, total_amount, created_at')
    .eq('id', orderId)
    .maybeSingle()

  if (error) throw error
  if (!order) return null

  const [{ data: listing }, { data: profiles }, { data: payment }, { data: historyRows }, { data: dispute }, { data: emailRows }] = await Promise.all([
    admin.from('listings').select('title, shipping_payer, delivery_available, merchant_delivery_available').eq('id', order.listing_id).maybeSingle(),
    admin.from('profiles').select('id, full_name, display_name, account_status, kyc_status').in('id', [order.buyer_id, order.seller_id]),
    admin.from('payments').select('*').eq('order_id', orderId).eq('payment_type', 'order_payment').maybeSingle(),
    admin.from('order_history').select('id, event_type, previous_status, new_status, actor_role, created_at').eq('order_id', orderId).order('created_at', { ascending: false }),
    admin.from('disputes').select('id, status, title').eq('order_id', orderId).maybeSingle(),
    admin.from('email_deliveries').select('id, event_type, status, created_at').eq('related_entity_type', 'order').eq('related_entity_id', orderId).order('created_at', { ascending: false }),
  ])

  const buyerProfile = profiles?.find((p) => p.id === order.buyer_id) ?? null
  const sellerProfile = profiles?.find((p) => p.id === order.seller_id) ?? null

  let attempts: Record<string, unknown>[] = []
  let events: Record<string, unknown>[] = []
  let ledgerEntryCount = 0
  if (payment) {
    const paymentId = (payment as { id: string }).id
    const [{ data: attemptRows }, { data: eventRows }, { data: ledgerRows }] = await Promise.all([
      admin.from('payment_attempts').select('*').eq('payment_id', paymentId).order('attempt_number', { ascending: true }),
      admin.from('payment_events').select('*').eq('payment_id', paymentId).order('created_at', { ascending: true }),
      admin.from('ledger_entries').select('id').eq('payment_id', paymentId),
    ])
    attempts = attemptRows ?? []
    events = eventRows ?? []
    ledgerEntryCount = (ledgerRows ?? []).length
  }

  return {
    order: {
      id: order.id,
      orderReference: order.order_reference,
      listingId: order.listing_id,
      listingTitle: listing?.title ?? null,
      buyerId: order.buyer_id,
      sellerId: order.seller_id,
      status: order.status,
      quantity: order.quantity,
      unitPrice: order.unit_price,
      shippingFee: order.shipping_fee,
      totalAmount: order.total_amount,
      currency: 'ZAR',
      createdAt: order.created_at,
      deliveryMethodHint: deriveDeliveryMethodHint(listing ?? null),
      lastLifecycleEvent: historyRows?.[0]?.event_type ?? null,
    },
    financial: {
      payment: payment ?? null,
      attempts,
      events,
      ledgerEntryCount,
      payoutStatus: 'not_applicable',
    },
    history: (historyRows ?? []).map((h) => ({
      id: h.id,
      eventType: h.event_type,
      previousStatus: h.previous_status,
      newStatus: h.new_status,
      actorRole: h.actor_role,
      createdAt: h.created_at,
    })),
    dispute: dispute ?? null,
    emailDeliveries: (emailRows ?? []).map((e) => ({ id: e.id, eventType: e.event_type, status: e.status, createdAt: e.created_at })),
    buyer: {
      id: order.buyer_id,
      name: buyerProfile?.full_name ?? buyerProfile?.display_name ?? null,
      accountStatus: buyerProfile?.account_status ?? null,
      kycStatus: buyerProfile?.kyc_status ?? null,
    },
    seller: {
      id: order.seller_id,
      name: sellerProfile?.full_name ?? sellerProfile?.display_name ?? null,
      accountStatus: sellerProfile?.account_status ?? null,
      kycStatus: sellerProfile?.kyc_status ?? null,
    },
  }
}

const CSV_COLUMNS: (keyof AdminOrderRow)[] = [
  'orderReference',
  'listingTitle',
  'buyerName',
  'sellerName',
  'status',
  'paymentStatus',
  'financialReadiness',
  'totalAmount',
  'currency',
  'createdAt',
  'lastLifecycleEvent',
  'disputed',
]

/**
 * Safe-fields-only export -- no email, no KYC document fields, no
 * addresses, no provider payloads, no banking details, no service-role
 * information. Reuses the existing toCsv()/csvResponse() helpers
 * unchanged.
 */
export async function exportAdminOrdersCsv(admin: SupabaseClient, filters: AdminOrderFilters): Promise<AdminOrderRow[]> {
  return listAdminOrders(admin, filters)
}

export const ORDER_CSV_COLUMNS = CSV_COLUMNS

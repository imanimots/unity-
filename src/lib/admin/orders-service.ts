import type { SupabaseClient } from '@supabase/supabase-js'
import { decodeAndValidateCursor, encodeKeysetCursor, computeCursorContextHash } from '@/lib/admin/cursor'

const DEFAULT_LIMIT = 100
const CURSOR_ENTITY = 'admin_orders'

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
  /** Opaque keyset cursor from a prior page's nextCursor -- see src/lib/admin/cursor.ts. */
  cursor?: string
}

export interface AdminOrderPage {
  orders: AdminOrderRow[]
  hasMore: boolean
  nextCursor: string | null
}

interface AdminOrderPageRow {
  id: string
  order_reference: string
  listing_id: string
  buyer_id: string
  seller_id: string
  status: string
  total_amount: number
  created_at: string
}

/** The exact filter fields that participate in cursor context-binding -- must match 1:1 with what the RPC call below filters on, so a filter change always invalidates a stale cursor. */
function orderCursorContextParams(filters: AdminOrderFilters) {
  return {
    status: filters.status ?? null,
    paymentStatus: filters.paymentStatus ?? null,
    disputed: filters.disputed ?? null,
    buyerId: filters.buyerId ?? null,
    sellerId: filters.sellerId ?? null,
    search: filters.search ?? null,
  }
}

/**
 * Bounded, relational, keyset-paginated via the _admin_list_orders_page
 * RPC (20260904000026) -- status/buyerId/sellerId/paymentStatus/disputed/
 * search are all now genuine SQL WHERE predicates applied before the
 * LIMIT, replacing the prior bounded-fetch-then-Node-filter behavior for
 * paymentStatus/disputed/search. The existing batched hydration
 * (profiles/listings/payments/history/disputes/email_deliveries) is
 * unchanged -- the RPC only replaces the base `orders` row fetch.
 */
export async function listAdminOrders(admin: SupabaseClient, filters: AdminOrderFilters): Promise<AdminOrderPage> {
  const contextParams = orderCursorContextParams(filters)
  const cursor = filters.cursor ? decodeAndValidateCursor(filters.cursor, CURSOR_ENTITY, contextParams) : null

  const requestedLimit = filters.limit ?? DEFAULT_LIMIT
  const { data: pageRows, error: rpcError }: { data: AdminOrderPageRow[] | null; error: { message: string } | null } = await admin.rpc('_admin_list_orders_page', {
    p_status: filters.status ?? null,
    p_buyer_id: filters.buyerId ?? null,
    p_seller_id: filters.sellerId ?? null,
    p_payment_status: filters.paymentStatus ?? null,
    p_disputed: filters.disputed ?? null,
    p_search: filters.search ?? null,
    p_cursor_created_at: cursor?.ts ?? null,
    p_cursor_id: cursor?.id ?? null,
    // Fetch one extra row to detect "more pages exist" without relying on
    // "returned length === limit" (which is ambiguous when exactly the
    // remaining rows equal the page size).
    p_limit: requestedLimit + 1,
  })
  if (rpcError) throw rpcError

  const hasMore = (pageRows?.length ?? 0) > requestedLimit
  const rows = (pageRows ?? []).slice(0, requestedLimit)
  const nextCursor = hasMore && rows.length > 0
    ? encodeKeysetCursor({ ts: rows[rows.length - 1].created_at, id: rows[rows.length - 1].id, contextHash: computeCursorContextHash(CURSOR_ENTITY, contextParams) })
    : null

  if (rows.length === 0) return { orders: [], hasMore: false, nextCursor: null }

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

  // paymentStatus/disputed/search are already applied server-side by
  // _admin_list_orders_page -- no post-limit Node filtering here anymore.
  const results: AdminOrderRow[] = rows.map((r) => {
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

  return { orders: results, hasMore, nextCursor }
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
 * unchanged. Exports the first page only (same bound CSV export has
 * always had) -- unlike before, that first page is now genuinely
 * filtered server-side rather than filtered-then-truncated.
 */
export async function exportAdminOrdersCsv(admin: SupabaseClient, filters: AdminOrderFilters): Promise<AdminOrderRow[]> {
  const { orders } = await listAdminOrders(admin, filters)
  return orders
}

export const ORDER_CSV_COLUMNS = CSV_COLUMNS

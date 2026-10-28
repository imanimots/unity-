import type { SupabaseClient } from '@supabase/supabase-js'
import { loadBookingFinancialState } from '@/lib/checkout/load-financial-state'
import { deriveFinancialReadiness } from '@/lib/checkout/financial-readiness'
import { decodeAndValidateCursor, encodeKeysetCursor, computeCursorContextHash } from '@/lib/admin/cursor'
import { classifyEntityWithOwners } from '@/lib/admin/data-scope'

const DEFAULT_LIMIT = 100
const FIN_OPS_CURSOR_ENTITY = 'admin_financial_operations'

export interface AdminBookingRow {
  id: string
  bookingReference: string | null
  listingTitle: string | null
  renterId: string
  renterName: string | null
  merchantId: string
  merchantName: string | null
  status: string
  financialReadiness: string
  startAt: string | null
  endAt: string | null
  paymentDueAt: string | null
  createdAt: string
  lastLifecycleEvent: string | null
}

export interface AdminBookingFilters {
  status?: string
  search?: string
  limit?: number
  /** Customer/Merchant 360 deep-link filter -- bookings where this user is either the renter or the merchant. Caller must have already validated this is a real UUID. */
  participantUserId?: string
}

/**
 * Reuses loadBookingFinancialState/deriveFinancialReadiness exactly as
 * the checkout routes do (src/lib/checkout) rather than re-deriving
 * readiness with separate admin-only logic — one source of truth for
 * "is this booking financially ready", per docs/PAYMENT_READINESS.md.
 * Acceptable at the current QA/public-test data volume (documented as a
 * known scaling limitation for a much larger booking table).
 */
/**
 * D3-D: real booking requires EVERY required participant positively
 * real -- renter AND merchant (bookings.renter_id/.merchant_id ->
 * profiles.id, FKs `bookings_renter_id_fkey`/`bookings_merchant_id_fkey`,
 * confirmed from supabase/migrations/20260613000001_initial_schema.sql)
 * -- AND the underlying listing not explicitly test
 * (bookings.listing_id -> listings.id, listings.is_test). bookings
 * itself has no is_test column of its own. Scoped at the database level
 * via inner-joined profiles (aliased per side, since both FKs target
 * the same table) and an inner-joined listing, before `.limit()`.
 */
export async function listAdminBookings(admin: SupabaseClient, filters: AdminBookingFilters): Promise<AdminBookingRow[]> {
  let query = admin
    .from('bookings')
    .select(
      `id, booking_reference, listing_id, renter_id, merchant_id, status, start_at, end_at, payment_due_at, created_at,
      listings!inner(title, is_test),
      renter_profile:profiles!bookings_renter_id_fkey!inner(data_classification),
      merchant_profile:profiles!bookings_merchant_id_fkey!inner(data_classification)`
    )
    .eq('listings.is_test', false)
    .eq('renter_profile.data_classification', 'real')
    .eq('merchant_profile.data_classification', 'real')
    .order('created_at', { ascending: false })
    .limit(filters.limit ?? DEFAULT_LIMIT)

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)
  if (filters.participantUserId) {
    query = query.or(`renter_id.eq.${filters.participantUserId},merchant_id.eq.${filters.participantUserId}`)
  }

  const { data: rows, error } = await query
  if (error) throw error
  if (!rows || rows.length === 0) return []

  const userIds = Array.from(new Set(rows.flatMap((r) => [r.renter_id, r.merchant_id])))
  const bookingIds = rows.map((r) => r.id)

  const [{ data: profiles }, { data: historyRows }, readiness] = await Promise.all([
    admin.from('profiles').select('id, full_name, display_name').in('id', userIds),
    admin.from('booking_history').select('booking_id, event_type, created_at').in('booking_id', bookingIds).order('created_at', { ascending: false }),
    Promise.all(rows.map(async (r) => {
      const state = await loadBookingFinancialState(admin, r.id)
      if (!state.booking) return 'not_prepared'
      return deriveFinancialReadiness({
        bookingStatus: state.booking.status,
        renterTotalAmount: state.booking.renterTotalAmount,
        workflowStatus: state.workflowStatus,
        rentalPaymentStatus: state.rentalPaymentStatus,
        depositRequired: state.booking.depositAmountSnapshot !== null && state.booking.depositAmountSnapshot > 0,
        depositPaymentStatus: state.depositPaymentStatus,
        paymentExpired: !!state.booking.paymentExpiredAt,
      })
    })),
  ])

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))
  const latestEventByBooking = new Map<string, string>()
  for (const h of historyRows ?? []) {
    if (!latestEventByBooking.has(h.booking_id)) latestEventByBooking.set(h.booking_id, h.event_type)
  }

  let filtered = rows.map((r, i) => ({
    id: r.id,
    bookingReference: r.booking_reference,
    listingTitle: (r.listings as unknown as { title: string } | null)?.title ?? null,
    renterId: r.renter_id,
    renterName: nameById.get(r.renter_id) ?? null,
    merchantId: r.merchant_id,
    merchantName: nameById.get(r.merchant_id) ?? null,
    status: r.status,
    financialReadiness: readiness[i],
    startAt: r.start_at,
    endAt: r.end_at,
    paymentDueAt: r.payment_due_at,
    createdAt: r.created_at,
    lastLifecycleEvent: latestEventByBooking.get(r.id) ?? null,
  }))

  if (filters.search && filters.search.trim()) {
    const q = filters.search.trim().toLowerCase()
    filtered = filtered.filter(
      (b) =>
        (b.bookingReference ?? '').toLowerCase().includes(q) ||
        (b.listingTitle ?? '').toLowerCase().includes(q) ||
        (b.renterName ?? '').toLowerCase().includes(q) ||
        (b.merchantName ?? '').toLowerCase().includes(q)
    )
  }

  return filtered
}

export interface AdminBookingDetail {
  booking: AdminBookingRow & { subtotalAmount: number | null; depositAmount: number | null; renterTotalAmount: number | null; currency: string | null }
  financial: {
    workflowStatus: string | null
    rentalPaymentStatus: string | null
    depositPaymentStatus: string | null
    rentalFailureReason: string | null
    depositFailureReason: string | null
  }
  history: Array<{ id: string; eventType: string; previousStatus: string | null; newStatus: string; createdAt: string }>
  emailEvents: Array<{ id: string; eventType: string; status: string; createdAt: string }>
  renterAccountStatus: string | null
  merchantAccountStatus: string | null
}

export async function getAdminBookingDetail(admin: SupabaseClient, bookingId: string): Promise<AdminBookingDetail | null> {
  const { data: booking, error } = await admin
    .from('bookings')
    .select('id, booking_reference, listing_id, renter_id, merchant_id, status, start_at, end_at, payment_due_at, created_at, subtotal_amount, deposit_amount_snapshot, renter_total_amount, currency, listings(title, is_test)')
    .eq('id', bookingId)
    .maybeSingle()

  if (error) throw error
  if (!booking) return null

  const { data: scopeProfiles } = await admin
    .from('profiles')
    .select('id, full_name, display_name, account_status, data_classification')
    .in('id', [booking.renter_id, booking.merchant_id])

  const renterProfile = scopeProfiles?.find((p) => p.id === booking.renter_id)
  const merchantProfile = scopeProfiles?.find((p) => p.id === booking.merchant_id)
  const bookingListing = booking.listings as unknown as { title: string; is_test: boolean } | null

  // D3-D: a known test/unknown-linked booking id must not load as an
  // ordinary Real Data booking detail. Checked before the financial
  // state/history/email fetches below, not merely before the response.
  if (classifyEntityWithOwners({ is_test: bookingListing?.is_test === true }, [renterProfile ?? {}, merchantProfile ?? {}]) !== 'real') {
    return null
  }

  const [state, { data: historyRows }, { data: emailRows }] = await Promise.all([
    loadBookingFinancialState(admin, bookingId),
    admin.from('booking_history').select('id, event_type, previous_status, new_status, created_at').eq('booking_id', bookingId).order('created_at', { ascending: false }),
    admin.from('email_deliveries').select('id, event_type, status, created_at').eq('related_entity_type', 'booking').eq('related_entity_id', bookingId).order('created_at', { ascending: false }),
  ])

  const financialReadiness = state.booking
    ? deriveFinancialReadiness({
        bookingStatus: state.booking.status,
        renterTotalAmount: state.booking.renterTotalAmount,
        workflowStatus: state.workflowStatus,
        rentalPaymentStatus: state.rentalPaymentStatus,
        depositRequired: state.booking.depositAmountSnapshot !== null && state.booking.depositAmountSnapshot > 0,
        depositPaymentStatus: state.depositPaymentStatus,
        paymentExpired: !!state.booking.paymentExpiredAt,
      })
    : 'not_prepared'

  return {
    booking: {
      id: booking.id,
      bookingReference: booking.booking_reference,
      listingTitle: bookingListing?.title ?? null,
      renterId: booking.renter_id,
      renterName: renterProfile?.full_name ?? renterProfile?.display_name ?? null,
      merchantId: booking.merchant_id,
      merchantName: merchantProfile?.full_name ?? merchantProfile?.display_name ?? null,
      status: booking.status,
      financialReadiness,
      startAt: booking.start_at,
      endAt: booking.end_at,
      paymentDueAt: booking.payment_due_at,
      createdAt: booking.created_at,
      lastLifecycleEvent: historyRows?.[0]?.event_type ?? null,
      subtotalAmount: booking.subtotal_amount,
      depositAmount: booking.deposit_amount_snapshot,
      renterTotalAmount: booking.renter_total_amount,
      currency: booking.currency,
    },
    financial: {
      workflowStatus: state.workflowStatus,
      rentalPaymentStatus: state.rentalPaymentStatus,
      depositPaymentStatus: state.depositPaymentStatus,
      rentalFailureReason: state.rentalFailureReason,
      depositFailureReason: state.depositFailureReason,
    },
    history: (historyRows ?? []).map((h) => ({ id: h.id, eventType: h.event_type, previousStatus: h.previous_status, newStatus: h.new_status, createdAt: h.created_at })),
    emailEvents: (emailRows ?? []).map((e) => ({ id: e.id, eventType: e.event_type, status: e.status, createdAt: e.created_at })),
    renterAccountStatus: renterProfile?.account_status ?? null,
    merchantAccountStatus: merchantProfile?.account_status ?? null,
  }
}

export interface AdminFinancialRow {
  paymentId: string
  bookingId: string | null
  bookingReference: string | null
  orderId: string | null
  orderReference: string | null
  paymentType: string
  status: string
  amount: number
  currency: string
  workflowStatus: string | null
  failureCategory: 'retryable' | 'terminal' | 'failed' | null
  failureReason: string | null
  ledgerEntryCount: number
  payoutStatus: string | null
}

/**
 * Provider-neutral financial monitoring: normalized status, amount,
 * workflow status, ledger-entry count, payout state. Never selects raw
 * provider payloads/webhook bodies — payment_webhook_events is not
 * queried here at all.
 *
 * Step 11 Phase 6: extended (not forked) to also label order-linked rows
 * correctly. Before this, an order-linked payment row rendered with a
 * silent null booking reference and null failure category -- the exact,
 * confirmed-real bug this fix targets. `booking_id`/`order_id` are
 * nullable side-by-side (exactly one populated per row, same
 * exactly-one-of shape `payments` itself enforces). An order row never
 * has a `financial_workflows` entry (orders use a single-step charge
 * flow, see chargeOrderPayment()'s own header comment) -- its
 * failureCategory is derived directly from `payment.status === 'failed'`
 * instead, a deliberately simpler category than bookings' retryable/
 * terminal split, because that split isn't durably stored for orders
 * (see docs/ORDER_ADMINISTRATION.md). `merchant_payouts` has no
 * order_id/payment_id column at all -- an order row's payoutStatus is
 * never queried for, always `'not_applicable'`, not left to fall
 * through to a lookup that can never match.
 */
export interface AdminFinancialOperationsFilters {
  status?: string
  limit?: number
  /** Opaque keyset cursor from a prior page's nextCursor -- see src/lib/admin/cursor.ts. */
  cursor?: string
}

export interface AdminFinancialOperationsPage {
  operations: AdminFinancialRow[]
  hasMore: boolean
  nextCursor: string | null
}

/**
 * Bounded keyset pagination on top of the SAME `payments` query and the
 * SAME `bookings(booking_reference)`/`orders(order_reference)` embedded
 * joins as before (confirmed correct by the diagnosis phase -- the
 * financial-operations defect was pure boundedness, never a join/
 * hydration bug, so the relation itself is deliberately unchanged here).
 */
export async function listFinancialOperations(admin: SupabaseClient, filters: AdminFinancialOperationsFilters): Promise<AdminFinancialOperationsPage> {
  const contextParams = { status: filters.status ?? null }
  const cursor = filters.cursor ? decodeAndValidateCursor(filters.cursor, FIN_OPS_CURSOR_ENTITY, contextParams) : null

  const requestedLimit = filters.limit ?? DEFAULT_LIMIT
  let query = admin
    .from('payments')
    .select('id, booking_id, order_id, payment_type, status, amount, currency, failure_reason, requested_at, bookings(booking_reference), orders(order_reference)')
    .order('requested_at', { ascending: false })
    .order('id', { ascending: false })
    // Fetch one extra row to detect "more pages exist" without relying on
    // "returned length === limit" (ambiguous when exactly that many rows remain).
    .limit(requestedLimit + 1)

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)
  if (cursor) {
    query = query.or(`requested_at.lt.${cursor.ts},and(requested_at.eq.${cursor.ts},id.lt.${cursor.id})`)
  }

  const { data: pagePayments, error } = await query
  if (error) throw error

  const hasMore = (pagePayments?.length ?? 0) > requestedLimit
  const payments = (pagePayments ?? []).slice(0, requestedLimit)
  const nextCursor = hasMore && payments.length > 0
    ? encodeKeysetCursor({
        ts: (payments[payments.length - 1] as { requested_at: string }).requested_at,
        id: payments[payments.length - 1].id,
        contextHash: computeCursorContextHash(FIN_OPS_CURSOR_ENTITY, contextParams),
      })
    : null

  if (payments.length === 0) return { operations: [], hasMore: false, nextCursor: null }

  const bookingIds = Array.from(new Set(payments.map((p) => p.booking_id).filter((id): id is string => !!id)))
  const paymentIds = payments.map((p) => p.id)

  const [{ data: workflows }, { data: ledgerRows }, { data: payouts }] = await Promise.all([
    admin.from('financial_workflows').select('booking_id, status').in('booking_id', bookingIds),
    admin.from('ledger_entries').select('payment_id').in('payment_id', paymentIds),
    admin.from('merchant_payouts').select('booking_id, status').in('booking_id', bookingIds),
  ])

  const workflowByBooking = new Map((workflows ?? []).map((w) => [w.booking_id, w.status]))
  const payoutByBooking = new Map((payouts ?? []).map((p) => [p.booking_id, p.status]))
  const ledgerCountByPayment = new Map<string, number>()
  for (const l of ledgerRows ?? []) {
    ledgerCountByPayment.set(l.payment_id, (ledgerCountByPayment.get(l.payment_id) ?? 0) + 1)
  }

  const operations: AdminFinancialRow[] = payments.map((p) => {
    if (p.order_id) {
      const failureCategory: AdminFinancialRow['failureCategory'] = p.status === 'failed' ? 'failed' : null
      return {
        paymentId: p.id,
        bookingId: null,
        bookingReference: null,
        orderId: p.order_id,
        orderReference: (p.orders as unknown as { order_reference: string } | null)?.order_reference ?? null,
        paymentType: p.payment_type,
        status: p.status,
        amount: p.amount,
        currency: p.currency,
        workflowStatus: null,
        failureCategory,
        failureReason: p.failure_reason,
        ledgerEntryCount: ledgerCountByPayment.get(p.id) ?? 0,
        payoutStatus: 'not_applicable',
      }
    }

    const workflowStatus = p.booking_id ? (workflowByBooking.get(p.booking_id) ?? null) : null
    const failureCategory: AdminFinancialRow['failureCategory'] =
      workflowStatus === 'failed_retryable' ? 'retryable' : workflowStatus === 'failed_terminal' ? 'terminal' : null
    return {
      paymentId: p.id,
      bookingId: p.booking_id,
      bookingReference: (p.bookings as unknown as { booking_reference: string } | null)?.booking_reference ?? null,
      orderId: null,
      orderReference: null,
      paymentType: p.payment_type,
      status: p.status,
      amount: p.amount,
      currency: p.currency,
      workflowStatus,
      failureCategory,
      failureReason: p.failure_reason,
      ledgerEntryCount: ledgerCountByPayment.get(p.id) ?? 0,
      payoutStatus: p.booking_id ? (payoutByBooking.get(p.booking_id) ?? null) : null,
    }
  })

  return { operations, hasMore, nextCursor }
}

export interface RealBookingOverviewCounts {
  requestedBookings: number
  acceptedAwaitingPaymentBookings: number
  financiallyReadyBookings: number
  activeRentals: number
  overduePaymentDeadlines: number
}

/**
 * D3-D-F1: the 5 booking-derived Admin Overview metrics, scoped to
 * confirmed real bookings only -- listings.is_test=false AND renter
 * real AND merchant real (the exact same rule listAdminBookings
 * already applies). Preserves every existing status/payment-state
 * definition from get_admin_overview_stats() verbatim -- this changes
 * WHO counts, never WHAT counts as e.g. "financially ready".
 *
 * accepted_awaiting_payment_bookings/financially_ready_bookings mirror
 * a NOT EXISTS / EXISTS captured rental_charge payment check the RPC
 * expresses in one SQL statement -- PostgREST cannot express an EXISTS
 * subquery directly, so this fetches the real-scoped, status='accepted'
 * booking ids first (a bounded set -- only currently-accepted bookings,
 * not the whole table), then counts via a single batched `payments`
 * query, never per-row.
 */
export async function getRealBookingOverviewCounts(admin: SupabaseClient): Promise<RealBookingOverviewCounts> {
  const scopedBase = () =>
    admin
      .from('bookings')
      .select(
        'id, payment_due_at, payment_expired_at, listings!inner(is_test), renter_profile:profiles!bookings_renter_id_fkey!inner(data_classification), merchant_profile:profiles!bookings_merchant_id_fkey!inner(data_classification)',
        { count: 'exact', head: true }
      )
      .eq('listings.is_test', false)
      .eq('renter_profile.data_classification', 'real')
      .eq('merchant_profile.data_classification', 'real')

  const [{ count: requestedBookings }, { count: activeRentals }] = await Promise.all([
    scopedBase().eq('status', 'requested'),
    scopedBase().eq('status', 'active'),
  ])

  const { count: overduePaymentDeadlines } = await scopedBase()
    .eq('status', 'accepted')
    .not('payment_due_at', 'is', null)
    .lt('payment_due_at', new Date().toISOString())
    .is('payment_expired_at', null)

  const { data: acceptedRows } = await admin
    .from('bookings')
    .select(
      'id, listings!inner(is_test), renter_profile:profiles!bookings_renter_id_fkey!inner(data_classification), merchant_profile:profiles!bookings_merchant_id_fkey!inner(data_classification)'
    )
    .eq('listings.is_test', false)
    .eq('renter_profile.data_classification', 'real')
    .eq('merchant_profile.data_classification', 'real')
    .eq('status', 'accepted')

  const acceptedIds = (acceptedRows ?? []).map((r) => r.id)
  let financiallyReadyBookings = 0
  let acceptedAwaitingPaymentBookings = 0
  if (acceptedIds.length > 0) {
    const { data: capturedPayments } = await admin
      .from('payments')
      .select('booking_id')
      .eq('payment_type', 'rental_charge')
      .eq('status', 'captured')
      .in('booking_id', acceptedIds)
    const capturedBookingIds = new Set((capturedPayments ?? []).map((p) => p.booking_id))
    financiallyReadyBookings = acceptedIds.filter((id) => capturedBookingIds.has(id)).length
    acceptedAwaitingPaymentBookings = acceptedIds.length - financiallyReadyBookings
  }

  return {
    requestedBookings: requestedBookings ?? 0,
    acceptedAwaitingPaymentBookings,
    financiallyReadyBookings,
    activeRentals: activeRentals ?? 0,
    overduePaymentDeadlines: overduePaymentDeadlines ?? 0,
  }
}

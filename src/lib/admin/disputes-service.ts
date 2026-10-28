import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyEntityWithOwners, type ProfileDataClassification } from '@/lib/admin/data-scope'

const DEFAULT_LIMIT = 100

/**
 * D3-D: a dispute has no participants of its own beyond `raised_by` --
 * its real-data provenance is entirely inherited from whichever ONE of
 * its four nullable parent-transaction columns is set (confirmed
 * exactly-one via disputes_one_transaction_chk, widened across
 * 20260720000003/20260813000001/20260827000004 to cover booking/order/
 * barter_agreement/rent_to_buy_agreement). Each parent's rule reuses
 * the exact same positive-proof logic already applied to that parent's
 * own list/detail (bookings: renter+merchant+listing.is_test; orders:
 * buyer+seller+listing.is_test [D3-D-F1: orders.listing_id -> listings.id
 * is NOT NULL and authoritative, same relationship as bookings]; barter:
 * party_a+party_b; rent_to_buy: merchant+customer+agreement.is_test) --
 * never a dispute-specific reimplementation.
 */
async function resolveDisputeRealClassification(admin: SupabaseClient, dispute: Record<string, unknown>): Promise<ProfileDataClassification> {
  if (dispute.booking_id) {
    const { data: booking } = await admin.from('bookings').select('renter_id, merchant_id, listings(is_test)').eq('id', dispute.booking_id).maybeSingle()
    if (!booking) return 'unknown'
    const { data: profiles } = await admin.from('profiles').select('id, data_classification').in('id', [booking.renter_id, booking.merchant_id])
    const renter = profiles?.find((p) => p.id === booking.renter_id)
    const merchant = profiles?.find((p) => p.id === booking.merchant_id)
    const listing = booking.listings as unknown as { is_test: boolean } | null
    return classifyEntityWithOwners({ is_test: listing?.is_test === true }, [renter ?? {}, merchant ?? {}])
  }
  if (dispute.order_id) {
    const { data: order } = await admin.from('orders').select('buyer_id, seller_id, listing_id').eq('id', dispute.order_id).maybeSingle()
    if (!order) return 'unknown'
    const [{ data: profiles }, { data: listing }] = await Promise.all([
      admin.from('profiles').select('id, data_classification').in('id', [order.buyer_id, order.seller_id]),
      admin.from('listings').select('is_test').eq('id', order.listing_id).maybeSingle(),
    ])
    const buyer = profiles?.find((p) => p.id === order.buyer_id)
    const seller = profiles?.find((p) => p.id === order.seller_id)
    // D3-D-F1: inherit the COMPLETE order rule (buyer+seller+listing.is_test),
    // the same rule getAdminOrderDetail applies -- never a weaker,
    // dispute-specific version.
    return classifyEntityWithOwners({ is_test: listing?.is_test === true }, [buyer ?? {}, seller ?? {}])
  }
  if (dispute.barter_agreement_id) {
    const { data: agreement } = await admin.from('barter_agreements').select('party_a_id, party_b_id').eq('id', dispute.barter_agreement_id).maybeSingle()
    if (!agreement) return 'unknown'
    const { data: profiles } = await admin.from('profiles').select('id, data_classification').in('id', [agreement.party_a_id, agreement.party_b_id])
    const partyA = profiles?.find((p) => p.id === agreement.party_a_id)
    const partyB = profiles?.find((p) => p.id === agreement.party_b_id)
    return classifyEntityWithOwners({ is_test: false }, [partyA ?? {}, partyB ?? {}])
  }
  if (dispute.rent_to_buy_agreement_id) {
    const { data: agreement } = await admin.from('rent_to_buy_agreements').select('merchant_id, customer_id, is_test').eq('id', dispute.rent_to_buy_agreement_id).maybeSingle()
    if (!agreement) return 'unknown'
    const { data: profiles } = await admin.from('profiles').select('id, data_classification').in('id', [agreement.merchant_id, agreement.customer_id])
    const merchant = profiles?.find((p) => p.id === agreement.merchant_id)
    const customer = profiles?.find((p) => p.id === agreement.customer_id)
    return classifyEntityWithOwners({ is_test: agreement.is_test === true }, [merchant ?? {}, customer ?? {}])
  }
  // Every dispute has exactly one parent per disputes_one_transaction_chk --
  // reaching here means none of the four columns were populated, which the
  // DB constraint should never allow. Fail safe, never guess real.
  return 'unknown'
}

export interface AdminDisputeRow {
  id: string
  title: string
  status: string
  transactionType: 'booking' | 'order' | 'barter'
  transactionId: string
  transactionReference: string | null
  raisedById: string
  raisedByName: string | null
  assignedAdminId: string | null
  assignedAdminName: string | null
  outcome: string | null
  createdAt: string
  updatedAt: string
}

export interface AdminDisputeFilters {
  status?: string
  search?: string
  limit?: number
  /** Customer/Merchant 360 deep-link filter -- every dispute this user raised, or that touches a booking/order/barter agreement they're a party to. Caller must have already validated this is a real UUID (see isValidUuid in route-helpers). */
  participantUserId?: string
}

/**
 * `disputes` itself only has `raised_by` -- the OTHER party is only
 * knowable by resolving the linked booking/order/barter_agreement and
 * reading ITS participant columns. Shared by the participantUserId
 * filter below and countAdminDisputesForUser, so a user's "disputes
 * involving them" always means the same thing in both the Customer 360
 * count and the filtered list.
 */
async function getDisputeParticipantEntityIds(admin: SupabaseClient, userId: string) {
  const [{ data: bookings }, { data: orders }, { data: barters }] = await Promise.all([
    admin.from('bookings').select('id').or(`renter_id.eq.${userId},merchant_id.eq.${userId}`),
    admin.from('orders').select('id').or(`buyer_id.eq.${userId},seller_id.eq.${userId}`),
    admin.from('barter_agreements').select('id').or(`party_a_id.eq.${userId},party_b_id.eq.${userId}`),
  ])
  return {
    bookingIds: (bookings ?? []).map((b) => b.id as string),
    orderIds: (orders ?? []).map((o) => o.id as string),
    barterIds: (barters ?? []).map((b) => b.id as string),
  }
}

function disputeParticipantOrClause(userId: string, ids: { bookingIds: string[]; orderIds: string[]; barterIds: string[] }): string {
  const clauses = [`raised_by.eq.${userId}`]
  if (ids.bookingIds.length) clauses.push(`booking_id.in.(${ids.bookingIds.join(',')})`)
  if (ids.orderIds.length) clauses.push(`order_id.in.(${ids.orderIds.join(',')})`)
  if (ids.barterIds.length) clauses.push(`barter_agreement_id.in.(${ids.barterIds.join(',')})`)
  return clauses.join(',')
}

/** Customer/Merchant 360's real "Disputes" count -- replaces the prior hardcoded `disputeCount: null`. */
export async function countAdminDisputesForUser(admin: SupabaseClient, userId: string): Promise<number> {
  const ids = await getDisputeParticipantEntityIds(admin, userId)
  const { count, error } = await admin.from('disputes').select('id', { count: 'exact', head: true }).or(disputeParticipantOrClause(userId, ids))
  if (error) throw error
  return count ?? 0
}

/**
 * Mirrors listAdminBookings' exact shape (operations-service.ts): one
 * base query + Promise.all of related rows + in-memory joins, no
 * separate "service class". A dispute's transaction reference is
 * resolved from whichever of booking_id/order_id/barter_agreement_id
 * is set -- the same generic pattern the dispute RPCs themselves use.
 */
/**
 * D3-D: a dispute's real-data provenance is inherited from its one
 * linked parent transaction (see resolveDisputeRealClassification's own
 * comment) -- PostgREST cannot express "join whichever of 3 different
 * parent tables is non-null" in a single embedded-relationship query,
 * so this list cannot apply the real-data filter purely at the initial
 * `disputes` query level the way a single-table list can. Instead:
 * status/participant filters still apply at the DB level as before,
 * but the row-count bound moves to AFTER classification (never before
 * it, which would be the exact bounded-fetch-then-filter anti-pattern
 * this phase forbids) -- mirroring listAdminBookings' own documented
 * acceptance of this tradeoff at the current data volume. Participant
 * ids/is_test flags for all three parent types are resolved via the
 * same batched (never per-row) queries this function already ran for
 * reference display, extended with the columns classification needs.
 */
export async function listAdminDisputes(admin: SupabaseClient, filters: AdminDisputeFilters): Promise<AdminDisputeRow[]> {
  let query = admin.from('disputes').select('*').order('created_at', { ascending: false })

  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)
  if (filters.participantUserId) {
    const ids = await getDisputeParticipantEntityIds(admin, filters.participantUserId)
    query = query.or(disputeParticipantOrClause(filters.participantUserId, ids))
  }

  const { data: initialRows, error } = await query
  if (error) throw error
  if (!initialRows || initialRows.length === 0) return []
  let rows = initialRows

  const bookingIds = rows.filter((r) => r.booking_id).map((r) => r.booking_id)
  const orderIds = rows.filter((r) => r.order_id).map((r) => r.order_id)
  const barterIds = rows.filter((r) => r.barter_agreement_id).map((r) => r.barter_agreement_id)

  const [{ data: bookings }, { data: orders }, { data: agreements }] = await Promise.all([
    bookingIds.length
      ? admin.from('bookings').select('id, booking_reference, renter_id, merchant_id, listings(is_test)').in('id', bookingIds)
      : Promise.resolve({ data: [] }),
    orderIds.length ? admin.from('orders').select('id, order_reference, buyer_id, seller_id').in('id', orderIds) : Promise.resolve({ data: [] }),
    barterIds.length
      ? admin.from('barter_agreements').select('id, agreement_reference, party_a_id, party_b_id').in('id', barterIds)
      : Promise.resolve({ data: [] }),
  ])

  const bookingById = new Map((bookings ?? []).map((b) => [b.id, b]))
  const orderById = new Map((orders ?? []).map((o) => [o.id, o]))
  const agreementById = new Map((agreements ?? []).map((a) => [a.id, a]))

  const participantIds = new Set<string>()
  for (const b of bookings ?? []) {
    participantIds.add(b.renter_id)
    participantIds.add(b.merchant_id)
  }
  for (const o of orders ?? []) {
    participantIds.add(o.buyer_id)
    participantIds.add(o.seller_id)
  }
  for (const a of agreements ?? []) {
    participantIds.add(a.party_a_id)
    participantIds.add(a.party_b_id)
  }

  const userIds = Array.from(
    new Set([...rows.map((r) => r.raised_by), ...rows.filter((r) => r.assigned_admin_id).map((r) => r.assigned_admin_id), ...participantIds])
  )

  const { data: profiles } = await admin.from('profiles').select('id, full_name, display_name, data_classification').in('id', userIds)

  const nameById = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? p.display_name]))
  const classificationById = new Map((profiles ?? []).map((p) => [p.id, { data_classification: p.data_classification }]))
  const bookingRefById = new Map((bookings ?? []).map((b) => [b.id, b.booking_reference]))
  const orderRefById = new Map((orders ?? []).map((o) => [o.id, o.order_reference]))
  const agreementRefById = new Map((agreements ?? []).map((a) => [a.id, a.agreement_reference]))

  rows = rows.filter((r) => {
    if (r.booking_id) {
      const booking = bookingById.get(r.booking_id)
      if (!booking) return false
      const listing = booking.listings as unknown as { is_test: boolean } | null
      const renter = classificationById.get(booking.renter_id) ?? {}
      const merchant = classificationById.get(booking.merchant_id) ?? {}
      return classifyEntityWithOwners({ is_test: listing?.is_test === true }, [renter, merchant]) === 'real'
    }
    if (r.order_id) {
      const order = orderById.get(r.order_id)
      if (!order) return false
      const buyer = classificationById.get(order.buyer_id) ?? {}
      const seller = classificationById.get(order.seller_id) ?? {}
      return classifyEntityWithOwners({ is_test: false }, [buyer, seller]) === 'real'
    }
    if (r.barter_agreement_id) {
      const agreement = agreementById.get(r.barter_agreement_id)
      if (!agreement) return false
      const partyA = classificationById.get(agreement.party_a_id) ?? {}
      const partyB = classificationById.get(agreement.party_b_id) ?? {}
      return classifyEntityWithOwners({ is_test: false }, [partyA, partyB]) === 'real'
    }
    // No recognized parent (e.g. rent_to_buy-linked, not yet a type this
    // list's own AdminDisputeRow contract represents) -- never guessed real.
    return false
  })

  let results: AdminDisputeRow[] = rows.slice(0, filters.limit ?? DEFAULT_LIMIT).map((r) => {
    const transactionType: AdminDisputeRow['transactionType'] = r.booking_id ? 'booking' : r.order_id ? 'order' : 'barter'
    const transactionId = r.booking_id ?? r.order_id ?? r.barter_agreement_id
    const transactionReference = r.booking_id
      ? (bookingRefById.get(r.booking_id) ?? null)
      : r.order_id
        ? (orderRefById.get(r.order_id) ?? null)
        : (agreementRefById.get(r.barter_agreement_id) ?? null)

    return {
      id: r.id,
      title: r.title,
      status: r.status,
      transactionType,
      transactionId,
      transactionReference,
      raisedById: r.raised_by,
      raisedByName: nameById.get(r.raised_by) ?? null,
      assignedAdminId: r.assigned_admin_id,
      assignedAdminName: r.assigned_admin_id ? (nameById.get(r.assigned_admin_id) ?? null) : null,
      outcome: r.outcome,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }
  })

  if (filters.search) {
    const q = filters.search.toLowerCase()
    results = results.filter(
      (d) =>
        d.title.toLowerCase().includes(q) ||
        (d.raisedByName ?? '').toLowerCase().includes(q) ||
        (d.transactionReference ?? '').toLowerCase().includes(q)
    )
  }

  return results
}

export interface AdminDisputeDetail {
  dispute: Record<string, unknown>
  history: Record<string, unknown>[]
  evidence: Record<string, unknown>[]
  /**
   * P6-HANDOVER-EVIDENCE-AND-TRUST-GATES-I: when this dispute is tied
   * to a booking, the booking's own real pre-handover/post-return
   * condition evidence -- a DISTINCT evidence class from dispute_evidence
   * (the allegation-side record a party submits once a dispute is
   * already open), never merged with it. Empty for an order/barter
   * dispute, since booking_condition_evidence only exists for ordinary
   * rental bookings.
   */
  bookingConditionEvidence: Record<string, unknown>[]
}

export async function getAdminDisputeDetail(admin: SupabaseClient, disputeId: string): Promise<AdminDisputeDetail | null> {
  const { data: dispute } = await admin.from('disputes').select('*').eq('id', disputeId).maybeSingle()
  if (!dispute) return null

  // D3-D: a known test/unknown-linked dispute id must not load as an
  // ordinary Real Data dispute detail -- checked before history/
  // evidence/booking-condition-evidence fetches below.
  if ((await resolveDisputeRealClassification(admin, dispute)) !== 'real') {
    return null
  }

  const [{ data: history }, { data: evidence }] = await Promise.all([
    admin.from('dispute_history').select('*').eq('dispute_id', disputeId).order('created_at', { ascending: true }),
    admin.from('dispute_evidence').select('*').eq('dispute_id', disputeId).order('created_at', { ascending: true }),
  ])

  let bookingConditionEvidence: Record<string, unknown>[] = []
  if (dispute.booking_id) {
    const { data } = await admin
      .from('booking_condition_evidence')
      .select('*')
      .eq('booking_id', dispute.booking_id)
      .order('evidence_stage', { ascending: true })
      .order('created_at', { ascending: true })
    bookingConditionEvidence = data ?? []
  }

  return { dispute, history: history ?? [], evidence: evidence ?? [], bookingConditionEvidence }
}

import type { SupabaseClient } from '@supabase/supabase-js'

export type ThreadType = 'booking' | 'order' | 'barter'

export interface ThreadRef {
  type: ThreadType
  id: string
  bookingId: string | null
  orderId: string | null
  barterAgreementId: string | null
  /** Set only when the caller resolved via a dispute reference -- the underlying transaction is what messages actually attach to. */
  disputeId: string | null
}

export interface ResolveThreadInput {
  bookingId?: string | null
  orderId?: string | null
  barterAgreementId?: string | null
  disputeId?: string | null
}

function buildRef(bookingId: string | null, orderId: string | null, barterAgreementId: string | null, disputeId: string | null): ThreadRef | null {
  const type: ThreadType | null = bookingId ? 'booking' : orderId ? 'order' : barterAgreementId ? 'barter' : null
  const id = bookingId ?? orderId ?? barterAgreementId
  if (!type || !id) return null
  return { type, id, bookingId, orderId, barterAgreementId, disputeId }
}

/**
 * The one place a thread reference (booking/order/barter/dispute id) is
 * resolved to its canonical transaction shape. Every consumer --
 * GET/POST /api/messages, the admin message route, email notification
 * code, and the dispute-route wrapper -- calls this instead of
 * re-deriving the join per call site.
 *
 * Exactly one of bookingId/orderId/barterAgreementId/disputeId must be
 * given (mirrors messages' own exactly-one-of CHECK). A dispute
 * reference resolves to its underlying transaction, exactly like the
 * old dispute route did inline.
 *
 * Pass whichever client fits the caller's trust level: a session client
 * scopes the lookup by that client's own RLS (a non-participant's
 * dispute reference comes back null, indistinguishable from
 * nonexistent -- the desired behavior for participant-facing routes); a
 * service-role client bypasses RLS entirely (for admin routes, which
 * must resolve any thread regardless of the admin's own participancy).
 */
export async function resolveThread(client: SupabaseClient, input: ResolveThreadInput): Promise<ThreadRef | null> {
  const provided = [input.bookingId, input.orderId, input.barterAgreementId, input.disputeId].filter((v) => v)
  if (provided.length !== 1) return null

  if (input.disputeId) {
    const { data: dispute } = await client
      .from('disputes')
      .select('id, booking_id, order_id, barter_agreement_id')
      .eq('id', input.disputeId)
      .maybeSingle()
    if (!dispute) return null
    return buildRef(dispute.booking_id, dispute.order_id, dispute.barter_agreement_id, dispute.id)
  }

  if (input.bookingId) {
    const { data } = await client.from('bookings').select('id').eq('id', input.bookingId).maybeSingle()
    if (!data) return null
    return buildRef(data.id, null, null, null)
  }

  if (input.orderId) {
    const { data } = await client.from('orders').select('id').eq('id', input.orderId).maybeSingle()
    if (!data) return null
    return buildRef(null, data.id, null, null)
  }

  const { data } = await client.from('barter_agreements').select('id').eq('id', input.barterAgreementId as string).maybeSingle()
  if (!data) return null
  return buildRef(null, null, data.id, null)
}

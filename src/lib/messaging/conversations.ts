import type { SupabaseClient } from '@supabase/supabase-js'
import type { ThreadType } from './thread-resolution'

export interface ConversationSummary {
  type: ThreadType
  id: string
  transactionReference: string | null
  listingTitle: string | null
  listingCoverUrl: string | null
  otherUserId: string
  otherUserName: string
  lastMessage: { content: string; createdAt: string; senderId: string; isFiltered: boolean } | null
  disputeId: string | null
}

function displayName(profile: { display_name: string | null; full_name: string | null } | null): string {
  return profile?.display_name || profile?.full_name || 'Unity user'
}

/**
 * Computes the inbox list in application code from the three
 * transaction tables plus each thread's latest message -- no
 * "Conversation" table or view anywhere (see thread-resolution.ts's
 * header comment for the same principle). Kept efficient via batched
 * Promise.all queries + in-memory joins, the same shape
 * operations-service.ts/disputes-service.ts already use -- not N+1 per
 * row regardless of how many transactions the caller has.
 *
 * Only surfaces transactions that already have at least one message --
 * an accepted booking with no chat activity yet doesn't clutter the
 * inbox; the "Message" entry point on each transaction's own actions
 * component is how a first message gets sent, which is what makes the
 * thread first appear here.
 */
export async function listMyConversations(admin: SupabaseClient, userId: string): Promise<ConversationSummary[]> {
  const [{ data: myBookings }, { data: myOrders }, { data: myAgreements }] = await Promise.all([
    admin.from('bookings').select('id, booking_reference, listing_id, renter_id, merchant_id').or(`renter_id.eq.${userId},merchant_id.eq.${userId}`),
    admin.from('orders').select('id, order_reference, listing_id, buyer_id, seller_id').or(`buyer_id.eq.${userId},seller_id.eq.${userId}`),
    admin.from('barter_agreements').select('id, agreement_reference, anchor_listing_id, party_a_id, party_b_id').or(`party_a_id.eq.${userId},party_b_id.eq.${userId}`),
  ])

  const bookingIds = (myBookings ?? []).map((b) => b.id)
  const orderIds = (myOrders ?? []).map((o) => o.id)
  const barterIds = (myAgreements ?? []).map((a) => a.id)

  if (bookingIds.length === 0 && orderIds.length === 0 && barterIds.length === 0) return []

  const [{ data: bookingMsgs }, { data: orderMsgs }, { data: barterMsgs }] = await Promise.all([
    bookingIds.length
      ? admin.from('messages').select('booking_id, dispute_id, content, sender_id, is_filtered, created_at').in('booking_id', bookingIds).order('created_at', { ascending: false })
      : Promise.resolve({ data: [] }),
    orderIds.length
      ? admin.from('messages').select('order_id, dispute_id, content, sender_id, is_filtered, created_at').in('order_id', orderIds).order('created_at', { ascending: false })
      : Promise.resolve({ data: [] }),
    barterIds.length
      ? admin.from('messages').select('barter_agreement_id, dispute_id, content, sender_id, is_filtered, created_at').in('barter_agreement_id', barterIds).order('created_at', { ascending: false })
      : Promise.resolve({ data: [] }),
  ])

  // First occurrence per key wins -- each result set is already ordered newest-first.
  function latestByKey<T extends Record<string, unknown>>(rows: T[], key: string): Map<string, T> {
    const map = new Map<string, T>()
    for (const row of rows) {
      const k = row[key] as string
      if (!map.has(k)) map.set(k, row)
    }
    return map
  }

  const latestBookingMsg = latestByKey(bookingMsgs ?? [], 'booking_id')
  const latestOrderMsg = latestByKey(orderMsgs ?? [], 'order_id')
  const latestBarterMsg = latestByKey(barterMsgs ?? [], 'barter_agreement_id')

  // Only threads with at least one message make the inbox.
  const activeBookings = (myBookings ?? []).filter((b) => latestBookingMsg.has(b.id))
  const activeOrders = (myOrders ?? []).filter((o) => latestOrderMsg.has(o.id))
  const activeAgreements = (myAgreements ?? []).filter((a) => latestBarterMsg.has(a.id))

  const listingIds = Array.from(
    new Set([...activeBookings.map((b) => b.listing_id), ...activeOrders.map((o) => o.listing_id), ...activeAgreements.map((a) => a.anchor_listing_id)])
  )
  const otherUserIds = Array.from(
    new Set([
      ...activeBookings.map((b) => (b.renter_id === userId ? b.merchant_id : b.renter_id)),
      ...activeOrders.map((o) => (o.buyer_id === userId ? o.seller_id : o.buyer_id)),
      ...activeAgreements.map((a) => (a.party_a_id === userId ? a.party_b_id : a.party_a_id)),
    ])
  )

  const [{ data: listings }, { data: media }, { data: profiles }] = await Promise.all([
    listingIds.length ? admin.from('listings').select('id, title').in('id', listingIds) : Promise.resolve({ data: [] }),
    listingIds.length ? admin.from('listing_media').select('listing_id, url, display_order').eq('type', 'photo').in('listing_id', listingIds).order('display_order', { ascending: true }) : Promise.resolve({ data: [] }),
    otherUserIds.length ? admin.from('profiles').select('id, display_name, full_name').in('id', otherUserIds) : Promise.resolve({ data: [] }),
  ])

  const titleById = new Map((listings ?? []).map((l) => [l.id, l.title]))
  const coverById = new Map<string, string>()
  for (const m of media ?? []) {
    if (!coverById.has(m.listing_id)) coverById.set(m.listing_id, m.url)
  }
  const nameById = new Map((profiles ?? []).map((p) => [p.id, p]))

  const results: ConversationSummary[] = []

  for (const b of activeBookings) {
    const msg = latestBookingMsg.get(b.id)!
    const otherId = b.renter_id === userId ? b.merchant_id : b.renter_id
    results.push({
      type: 'booking',
      id: b.id,
      transactionReference: b.booking_reference ?? null,
      listingTitle: titleById.get(b.listing_id) ?? null,
      listingCoverUrl: coverById.get(b.listing_id) ?? null,
      otherUserId: otherId,
      otherUserName: displayName(nameById.get(otherId) ?? null),
      lastMessage: { content: msg.content, createdAt: msg.created_at, senderId: msg.sender_id, isFiltered: msg.is_filtered },
      disputeId: msg.dispute_id ?? null,
    })
  }
  for (const o of activeOrders) {
    const msg = latestOrderMsg.get(o.id)!
    const otherId = o.buyer_id === userId ? o.seller_id : o.buyer_id
    results.push({
      type: 'order',
      id: o.id,
      transactionReference: o.order_reference ?? null,
      listingTitle: titleById.get(o.listing_id) ?? null,
      listingCoverUrl: coverById.get(o.listing_id) ?? null,
      otherUserId: otherId,
      otherUserName: displayName(nameById.get(otherId) ?? null),
      lastMessage: { content: msg.content, createdAt: msg.created_at, senderId: msg.sender_id, isFiltered: msg.is_filtered },
      disputeId: msg.dispute_id ?? null,
    })
  }
  for (const a of activeAgreements) {
    const msg = latestBarterMsg.get(a.id)!
    const otherId = a.party_a_id === userId ? a.party_b_id : a.party_a_id
    results.push({
      type: 'barter',
      id: a.id,
      transactionReference: a.agreement_reference ?? null,
      listingTitle: titleById.get(a.anchor_listing_id) ?? null,
      listingCoverUrl: coverById.get(a.anchor_listing_id) ?? null,
      otherUserId: otherId,
      otherUserName: displayName(nameById.get(otherId) ?? null),
      lastMessage: { content: msg.content, createdAt: msg.created_at, senderId: msg.sender_id, isFiltered: msg.is_filtered },
      disputeId: msg.dispute_id ?? null,
    })
  }

  results.sort((x, y) => (y.lastMessage?.createdAt ?? '').localeCompare(x.lastMessage?.createdAt ?? ''))
  return results
}

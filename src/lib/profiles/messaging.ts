import type { SupabaseClient } from '@supabase/supabase-js'

export interface SharedTransactionRef {
  type: 'booking' | 'order' | 'barter'
  id: string
}

/**
 * Unity's chat system has no generic "message any user" thread type --
 * every thread anchors to an existing booking/order/barter agreement
 * (src/lib/messaging/thread-resolution.ts's ThreadType). A profile's
 * Message action can therefore only ever open an EXISTING conversation,
 * never fabricate a new one out of nothing. Returns the most recently
 * created shared transaction between the two users across the three
 * domains that have chat support (RTB has none yet -- a separate,
 * pre-existing gap, not created by this feature). Returns null when no
 * shared transaction exists -- callers must omit the Message action
 * entirely in that case rather than showing a button with nowhere to go.
 */
export async function getMostRecentSharedTransaction(supabase: SupabaseClient, viewerId: string, profileId: string): Promise<SharedTransactionRef | null> {
  if (viewerId === profileId) return null

  const [{ data: bookings }, { data: orders }, { data: barters }] = await Promise.all([
    supabase
      .from('bookings')
      .select('id, created_at')
      .or(`and(renter_id.eq.${viewerId},merchant_id.eq.${profileId}),and(renter_id.eq.${profileId},merchant_id.eq.${viewerId})`)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('orders')
      .select('id, created_at')
      .or(`and(buyer_id.eq.${viewerId},seller_id.eq.${profileId}),and(buyer_id.eq.${profileId},seller_id.eq.${viewerId})`)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('barter_agreements')
      .select('id, created_at')
      .or(`and(party_a_id.eq.${viewerId},party_b_id.eq.${profileId}),and(party_a_id.eq.${profileId},party_b_id.eq.${viewerId})`)
      .order('created_at', { ascending: false })
      .limit(1),
  ])

  const candidates: (SharedTransactionRef & { createdAt: string })[] = [
    ...((bookings ?? []).map((b) => ({ type: 'booking' as const, id: b.id, createdAt: b.created_at }))),
    ...((orders ?? []).map((o) => ({ type: 'order' as const, id: o.id, createdAt: o.created_at }))),
    ...((barters ?? []).map((a) => ({ type: 'barter' as const, id: a.id, createdAt: a.created_at }))),
  ]
  if (candidates.length === 0) return null

  candidates.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  const winner = candidates[0]
  return { type: winner.type, id: winner.id }
}

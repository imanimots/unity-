import type { SupabaseClient } from '@supabase/supabase-js'
import { filterMessage } from '@/lib/chat-filter'
import { resolveThread, type ResolveThreadInput, type ThreadRef } from './thread-resolution'
import { notifyNewMessage } from './notify'

/**
 * The one send/list implementation -- GET/POST /api/messages and the
 * thin src/app/api/disputes/[id]/messages/route.ts wrapper both call
 * these, rather than duplicating the query/insert logic (review point
 * 1/2). There is no separate "dispute thread" grouping: a dispute
 * reference resolves (via resolveThread) to its underlying booking/
 * order/barter agreement, and list always returns that transaction's
 * full message history -- a message sent from the dispute detail view
 * is tagged with dispute_id but lands in the exact same thread anyone
 * viewing that transaction's chat sees. This is what "one messaging
 * model" means in practice: dispute chat isn't a second thread, it's
 * the same thread with some messages additionally tagged.
 */

function threadColumn(type: ThreadRef['type']): 'booking_id' | 'order_id' | 'barter_agreement_id' {
  return type === 'booking' ? 'booking_id' : type === 'order' ? 'order_id' : 'barter_agreement_id'
}

async function resolveOtherPartyId(admin: SupabaseClient, thread: ThreadRef, senderId: string): Promise<string | null> {
  if (thread.type === 'booking') {
    const { data } = await admin.from('bookings').select('renter_id, merchant_id').eq('id', thread.id).maybeSingle()
    if (!data) return null
    return data.renter_id === senderId ? data.merchant_id : data.renter_id
  }
  if (thread.type === 'order') {
    const { data } = await admin.from('orders').select('buyer_id, seller_id').eq('id', thread.id).maybeSingle()
    if (!data) return null
    return data.buyer_id === senderId ? data.seller_id : data.buyer_id
  }
  const { data } = await admin.from('barter_agreements').select('party_a_id, party_b_id').eq('id', thread.id).maybeSingle()
  if (!data) return null
  return data.party_a_id === senderId ? data.party_b_id : data.party_a_id
}

export interface SendMessageInput extends ResolveThreadInput {
  content: string
}

export type SendMessageResult = { ok: true; message: Record<string, unknown> } | { ok: false; status: number; error: string }

/**
 * `session` must be the caller's own session-scoped Supabase client
 * (never service-role) -- the actual insert runs through it so
 * "messages: parties send" RLS is the real enforcement of participancy,
 * preserving the established session-client-insert-under-RLS pattern
 * for this table (see docs/DISPUTE_SYSTEM.md's messaging note) rather
 * than moving to a service-role/RPC pattern. "The browser must never
 * write directly to the table" is satisfied at the route boundary: the
 * browser calls this trusted server route, which validates/filters/
 * checks idempotency before this function ever runs -- not by the
 * insert itself using a different client.
 *
 * `admin` (service-role) is used only for the best-effort recipient
 * lookup + email notify, which must work regardless of RLS.
 */
export async function sendMessage(
  session: SupabaseClient,
  admin: SupabaseClient,
  senderId: string,
  senderName: string,
  input: SendMessageInput
): Promise<SendMessageResult> {
  const thread = await resolveThread(session, {
    bookingId: input.bookingId,
    orderId: input.orderId,
    barterAgreementId: input.barterAgreementId,
    disputeId: input.disputeId,
  })
  if (!thread) return { ok: false, status: 404, error: 'Conversation not found' }

  const { blocked, reason } = filterMessage(input.content)

  const { data: message, error } = await session
    .from('messages')
    .insert({
      booking_id: thread.bookingId,
      order_id: thread.orderId,
      barter_agreement_id: thread.barterAgreementId,
      dispute_id: thread.disputeId,
      sender_id: senderId,
      content: input.content,
      is_filtered: blocked,
      filter_reason: reason,
    })
    .select('*')
    .single()

  if (error || !message) {
    return { ok: false, status: 500, error: 'Could not send this message' }
  }

  // Best-effort notify -- never blocks the response, and a blocked
  // (filtered) message never triggers an email regardless of debounce.
  if (!blocked) {
    try {
      const recipientId = await resolveOtherPartyId(admin, thread, senderId)
      if (recipientId) {
        await notifyNewMessage(admin, thread, recipientId, senderName, input.content.slice(0, 140), message.id as string)
      }
    } catch (notifyErr) {
      console.error('[messaging.send] notify failed', { threadType: thread.type, threadId: thread.id, notifyErr })
    }
  }

  return { ok: true, message }
}

export interface ListMessagesInput extends ResolveThreadInput {
  before?: string
  limit?: number
}

export type ListMessagesResult = { ok: true; messages: Record<string, unknown>[] } | { ok: false; status: number; error: string }

export async function listMessages(session: SupabaseClient, input: ListMessagesInput): Promise<ListMessagesResult> {
  const thread = await resolveThread(session, {
    bookingId: input.bookingId,
    orderId: input.orderId,
    barterAgreementId: input.barterAgreementId,
    disputeId: input.disputeId,
  })
  if (!thread) return { ok: false, status: 404, error: 'Conversation not found' }

  let query = session
    .from('messages')
    .select('*')
    .eq(threadColumn(thread.type), thread.id)
    .order('created_at', { ascending: false })
    .limit(input.limit ?? 50)
  if (input.before) query = query.lt('created_at', input.before)

  const { data, error } = await query
  if (error) return { ok: false, status: 500, error: 'Could not load messages' }

  const messages = (data ?? []).reverse()
  await attachAttachments(session, messages)
  return { ok: true, messages }
}

/** Batched, not N+1 -- one extra query for the whole page of messages, RLS-scoped by whichever client is passed in. */
export async function attachAttachments(client: SupabaseClient, messages: Record<string, unknown>[]): Promise<void> {
  const messageIds = messages.map((m) => m.id as string)
  if (messageIds.length === 0) return

  const { data: attachments } = await client.from('message_attachments').select('*').in('message_id', messageIds)
  if (!attachments || attachments.length === 0) return

  const byMessageId = new Map<string, Record<string, unknown>[]>()
  for (const a of attachments) {
    const key = a.message_id as string
    const list = byMessageId.get(key) ?? []
    list.push(a)
    byMessageId.set(key, list)
  }
  for (const m of messages) {
    m.attachments = byMessageId.get(m.id as string) ?? []
  }
}

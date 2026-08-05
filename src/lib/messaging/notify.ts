import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate, loadUserDisplayName } from '@/lib/email'
import type { ThreadRef } from './thread-resolution'

const PRESENCE_WINDOW_MS = 45_000
const LAST_MESSAGE_FALLBACK_WINDOW_MS = 10 * 60 * 1000

async function recipientHasRecentHeartbeat(admin: SupabaseClient, recipientId: string, thread: ThreadRef): Promise<boolean> {
  const { data } = await admin
    .from('message_thread_presence')
    .select('last_active_at')
    .eq('user_id', recipientId)
    .eq('transaction_type', thread.type)
    .eq('transaction_id', thread.id)
    .maybeSingle()
  if (!data) return false
  return Date.now() - new Date(data.last_active_at).getTime() < PRESENCE_WINDOW_MS
}

async function recipientSentRecently(admin: SupabaseClient, recipientId: string, thread: ThreadRef): Promise<boolean> {
  const column = thread.type === 'booking' ? 'booking_id' : thread.type === 'order' ? 'order_id' : 'barter_agreement_id'
  const since = new Date(Date.now() - LAST_MESSAGE_FALLBACK_WINDOW_MS).toISOString()
  const { data } = await admin
    .from('messages')
    .select('id')
    .eq(column, thread.id)
    .eq('sender_id', recipientId)
    .gte('created_at', since)
    .limit(1)
    .maybeSingle()
  return !!data
}

/**
 * Decides whether to email `recipientId` about a new message on
 * `thread`. Two-tier debounce (Phase 3 review point 8): a live presence
 * heartbeat within the last ~45s suppresses immediately -- the
 * recipient plausibly has the thread open right now; otherwise falls
 * back to the original "did the recipient send a message here in the
 * last 10 minutes" heuristic. Neither tier is full presence -- no
 * cross-device awareness, no "last seen" display, no typing indicators.
 * See docs/REAL_CHAT.md.
 */
export async function shouldNotifyRecipient(admin: SupabaseClient, recipientId: string, thread: ThreadRef): Promise<boolean> {
  if (await recipientHasRecentHeartbeat(admin, recipientId, thread)) return false
  if (await recipientSentRecently(admin, recipientId, thread)) return false
  return true
}

function resolveEntityType(type: ThreadRef['type']): 'booking' | 'order' | 'barter_agreement' {
  if (type === 'booking') return 'booking'
  if (type === 'order') return 'order'
  return 'barter_agreement'
}

/**
 * Sends the new-message-received email to `recipientId` if the
 * debounce allows it. `messageId` anchors the email's idempotency key
 * (via sendTemplate's occurrenceKey) so a retried request never double
 * sends -- this is a real per-message event, not a one-shot lifecycle
 * event, so occurrenceKey must vary per message while still being
 * stable across retries of the same message. Never throws --
 * sendTemplate() itself never throws, and a debounce skip is a normal
 * outcome, not an error.
 */
export async function notifyNewMessage(
  admin: SupabaseClient,
  thread: ThreadRef,
  recipientId: string,
  senderName: string,
  messagePreview: string,
  messageId: string
): Promise<void> {
  const shouldNotify = await shouldNotifyRecipient(admin, recipientId, thread)
  if (!shouldNotify) return

  const recipientName = await loadUserDisplayName(admin, recipientId)

  await sendTemplate(admin, {
    eventType: 'message.new',
    templateId: 'new-message-received',
    recipientUserId: recipientId,
    relatedEntityType: resolveEntityType(thread.type),
    relatedEntityId: thread.id,
    occurrenceKey: `message-${messageId}-${recipientId}`,
    vars: { recipientName, senderName, messagePreview },
  })
}

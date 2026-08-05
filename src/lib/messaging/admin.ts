import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveThread, type ResolveThreadInput, type ThreadRef } from './thread-resolution'
import { attachAttachments } from './service'

export interface AdminMessagesResult {
  thread: ThreadRef
  messages: Record<string, unknown>[]
}

/**
 * The one audited path for an admin to read a thread's messages -- both
 * GET /api/admin/messages and the retrofitted admin dispute detail page
 * (src/app/admin/disputes/[id]/page.tsx) call this rather than querying
 * `messages` directly, so every admin read of a user's private
 * conversation writes one row to admin_message_access_log (service-role
 * insert, before the data is returned) -- the first "an admin *viewed*
 * X" audit table in this codebase. Read-only: there is no companion
 * "admin send" path, matching the brief's "admin may view for
 * moderation, must not impersonate."
 *
 * Always called with a service-role client -- an admin must be able to
 * resolve and read any thread regardless of their own participancy,
 * which a session client's RLS would otherwise block.
 */
export async function getMessagesForAdmin(admin: SupabaseClient, adminId: string, ref: ResolveThreadInput): Promise<AdminMessagesResult | null> {
  const thread = await resolveThread(admin, ref)
  if (!thread) return null

  await admin.from('admin_message_access_log').insert({
    admin_id: adminId,
    booking_id: thread.bookingId,
    order_id: thread.orderId,
    barter_agreement_id: thread.barterAgreementId,
    dispute_id: ref.disputeId ?? null,
  })

  const column = thread.type === 'booking' ? 'booking_id' : thread.type === 'order' ? 'order_id' : 'barter_agreement_id'
  const { data, error } = await admin.from('messages').select('*').eq(column, thread.id).order('created_at', { ascending: true })

  if (error) throw error
  const messages = data ?? []
  await attachAttachments(admin, messages)
  return { thread, messages }
}

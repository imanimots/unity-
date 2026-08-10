import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate } from '@/lib/email'

/** Best-effort, idempotent (occurrenceKey), never throws into the caller's own flow -- mirrors src/lib/barter/notify.ts's shape. */
export async function notifyMarketplaceRequestParty(
  admin: SupabaseClient,
  requestId: string,
  recipientUserId: string,
  eventType: string,
  templateId: string,
  occurrenceKey: string
): Promise<void> {
  try {
    const [{ data: req }, { data: recipient }] = await Promise.all([
      admin.from('marketplace_requests').select('title').eq('id', requestId).maybeSingle(),
      admin.from('profiles').select('full_name, display_name').eq('id', recipientUserId).maybeSingle(),
    ])
    if (!req) return
    await sendTemplate(admin, {
      eventType,
      templateId,
      recipientUserId,
      relatedEntityType: 'marketplace_request',
      relatedEntityId: requestId,
      occurrenceKey,
      vars: { recipientName: recipient?.full_name ?? recipient?.display_name ?? 'there', requestTitle: req.title },
    })
  } catch (err) {
    console.error('[marketplace.notify] dispatch failed', { requestId, recipientUserId, eventType, err })
  }
}

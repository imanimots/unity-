import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate } from '@/lib/email'

/** Best-effort, idempotent (occurrenceKey), never throws into the caller's own flow -- mirrors src/lib/marketplace/notify.ts's shape. */
export async function notifyRentToBuyParty(
  admin: SupabaseClient,
  agreementId: string,
  recipientUserId: string,
  eventType: string,
  templateId: string,
  occurrenceKey: string
): Promise<void> {
  try {
    const [{ data: agreement }, { data: recipient }] = await Promise.all([
      admin.from('rent_to_buy_agreements').select('listing_id').eq('id', agreementId).maybeSingle(),
      admin.from('profiles').select('full_name, display_name').eq('id', recipientUserId).maybeSingle(),
    ])
    if (!agreement) return
    const { data: listing } = await admin.from('listings').select('title').eq('id', agreement.listing_id).maybeSingle()
    await sendTemplate(admin, {
      eventType,
      templateId,
      recipientUserId,
      relatedEntityType: 'rent_to_buy_agreement',
      relatedEntityId: agreementId,
      occurrenceKey,
      vars: { recipientName: recipient?.full_name ?? recipient?.display_name ?? 'there', listingTitle: listing?.title ?? 'your item' },
    })
  } catch (err) {
    console.error('[rent-to-buy.notify] dispatch failed', { agreementId, recipientUserId, eventType, err })
  }
}

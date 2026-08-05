import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate, loadDisputeEmailContext } from '@/lib/email'

/**
 * Sends the same template to both dispute parties -- the shape every
 * admin-action email in this domain shares (evidence_requested,
 * evidence_received, under_review, resolved, closed, cancelled). Only
 * dispute.opened needs two distinct templates (raiser vs. respondent
 * wording genuinely differs), so it's dispatched inline at the open
 * route instead of through this helper.
 */
export async function notifyDisputeParties(
  admin: SupabaseClient,
  disputeId: string,
  eventType: string,
  templateId: string,
  extraVars: Record<string, string | number> = {}
): Promise<void> {
  const ctx = await loadDisputeEmailContext(admin, disputeId)
  if (!ctx) return

  const { data: dispute } = await admin.from('disputes').select('booking_id, order_id, barter_agreement_id').eq('id', disputeId).maybeSingle()
  if (!dispute) return

  const relatedEntityType = dispute.booking_id ? 'booking' : dispute.order_id ? 'order' : 'barter_agreement'
  const relatedEntityId = dispute.booking_id ?? dispute.order_id ?? dispute.barter_agreement_id

  for (const recipient of [
    { userId: ctx.raiserId, name: ctx.raiserName, occurrenceSuffix: 'raiser' },
    { userId: ctx.respondentId, name: ctx.respondentName, occurrenceSuffix: 'respondent' },
  ]) {
    await sendTemplate(admin, {
      eventType,
      templateId,
      recipientUserId: recipient.userId,
      relatedEntityType,
      relatedEntityId,
      occurrenceKey: `dispute-${disputeId}-${eventType}-${recipient.occurrenceSuffix}`,
      vars: { recipientName: recipient.name, title: ctx.title, ...extraVars },
    })
  }
}

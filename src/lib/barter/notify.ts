import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate, loadBarterEmailContext } from '@/lib/email'

/**
 * Sends the same template to both trade parties -- mirrors
 * src/lib/disputes/notify.ts's notifyDisputeParties() shape. Barter has
 * no merchant/renter asymmetry to justify per-side wording the way
 * dispute.opened's raiser/respondent split does, so every Phase 4 email
 * except barter-completion-requested (see notifyBarterParty below) uses
 * one shared template sent to both.
 */
export async function notifyBarterParties(
  admin: SupabaseClient,
  agreementId: string,
  eventType: string,
  templateId: string,
  extraVars: Record<string, string | number> = {}
): Promise<void> {
  const ctx = await loadBarterEmailContext(admin, agreementId)
  if (!ctx) return

  for (const recipient of [
    { userId: ctx.partyAId, name: ctx.partyAName },
    { userId: ctx.partyBId, name: ctx.partyBName },
  ]) {
    await sendTemplate(admin, {
      eventType,
      templateId,
      recipientUserId: recipient.userId,
      relatedEntityType: 'barter_agreement',
      relatedEntityId: agreementId,
      occurrenceKey: `barter-${agreementId}-${eventType}-${recipient.userId}`,
      vars: { recipientName: recipient.name, agreementReference: ctx.agreementReference, listingTitle: ctx.anchorListingTitle, ...extraVars },
    })
  }
}

/** Sends to exactly one party -- barter-deposit-required (only the payer) and barter-completion-requested (only the other party). */
export async function notifyBarterParty(
  admin: SupabaseClient,
  agreementId: string,
  recipientId: string,
  eventType: string,
  templateId: string,
  extraVars: Record<string, string | number> = {}
): Promise<void> {
  const ctx = await loadBarterEmailContext(admin, agreementId)
  if (!ctx) return

  const recipientName = recipientId === ctx.partyAId ? ctx.partyAName : ctx.partyBName

  await sendTemplate(admin, {
    eventType,
    templateId,
    recipientUserId: recipientId,
    relatedEntityType: 'barter_agreement',
    relatedEntityId: agreementId,
    occurrenceKey: `barter-${agreementId}-${eventType}-${recipientId}`,
    vars: { recipientName, agreementReference: ctx.agreementReference, listingTitle: ctx.anchorListingTitle, ...extraVars },
  })
}

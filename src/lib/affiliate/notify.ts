import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate, loadAffiliateCommissionEmailContext, loadAffiliateListingEmailContext } from '@/lib/email'

/** Sends one commission-lifecycle event to the affiliate. */
export async function notifyAffiliateOfCommission(
  admin: SupabaseClient,
  commissionId: string,
  eventType: string,
  templateId: string,
  extraVars: Record<string, string | number> = {}
): Promise<void> {
  const ctx = await loadAffiliateCommissionEmailContext(admin, commissionId)
  if (!ctx) return

  await sendTemplate(admin, {
    eventType,
    templateId,
    recipientUserId: ctx.affiliateId,
    relatedEntityType: 'affiliate_commission',
    relatedEntityId: commissionId,
    occurrenceKey: `affiliate-commission-${commissionId}-${eventType}-${ctx.affiliateId}`,
    vars: {
      recipientName: ctx.affiliateName,
      listingTitle: ctx.listingTitle,
      commissionAmount: `R${ctx.commissionAmount.toFixed(2)}`,
      transactionReference: ctx.transactionReference,
      ...extraVars,
    },
  })
}

/**
 * Sends one merchant-facing affiliate event (enable/disable), scoped to
 * a listing. Enable/disable is a genuinely repeatable action (a
 * merchant may toggle it many times), so -- unlike a one-shot lifecycle
 * event -- each real action needs its own delivery. `occurrenceKey` is
 * supplied by the caller (the route's own idempotency key) rather than
 * generated here: a route retry with the SAME idempotency key must
 * still dedupe to one email, which a self-generated Date.now() would
 * have defeated.
 */
export async function notifyMerchantOfAffiliateEvent(
  admin: SupabaseClient,
  listingId: string,
  eventType: string,
  templateId: string,
  occurrenceKey: string,
  extraVars: Record<string, string | number> = {}
): Promise<void> {
  const ctx = await loadAffiliateListingEmailContext(admin, listingId)
  if (!ctx) return

  await sendTemplate(admin, {
    eventType,
    templateId,
    recipientUserId: ctx.merchantId,
    relatedEntityType: 'listing',
    relatedEntityId: listingId,
    occurrenceKey: `affiliate-listing-${listingId}-${eventType}-${ctx.merchantId}-${occurrenceKey}`,
    vars: { recipientName: ctx.merchantName, listingTitle: ctx.listingTitle, ...extraVars },
  })
}

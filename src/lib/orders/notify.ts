import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate, loadOrderEmailContext } from '@/lib/email'

interface OrderRoleRecipient {
  role: 'buyer' | 'seller'
  templateId: string
}

/**
 * Sends one event to the buyer and/or seller, each with their own
 * templateId -- unlike notifyBarterParties() (one shared templateId,
 * barter has no per-side wording split), orders routinely need different
 * wording for buyer vs seller (e.g. order.created -> order-created-buyer
 * vs order-received-seller), so the caller supplies a templateId per
 * role rather than one shared id. eventType stays the same across every
 * call for a given lifecycle moment -- only templateId varies by
 * audience (see docs/ORDER_ADMINISTRATION.md, "event vs template
 * identity"). Recipients are specified by role, not literal user id, so
 * a call site only ever needs the order id -- buyer_id/seller_id are
 * resolved from the order row itself, never trusted from the caller.
 */
export async function notifyOrderParties(
  admin: SupabaseClient,
  orderId: string,
  eventType: string,
  recipients: OrderRoleRecipient[],
  extraVars: Record<string, string | number> = {}
): Promise<void> {
  const ctx = await loadOrderEmailContext(admin, orderId)
  if (!ctx) return

  for (const recipient of recipients) {
    const userId = recipient.role === 'buyer' ? ctx.buyerId : ctx.sellerId
    const recipientName = recipient.role === 'buyer' ? ctx.buyerName : ctx.sellerName

    await sendTemplate(admin, {
      eventType,
      templateId: recipient.templateId,
      recipientUserId: userId,
      relatedEntityType: 'order',
      relatedEntityId: orderId,
      occurrenceKey: `order-${orderId}-${eventType}-${userId}`,
      vars: { recipientName, orderReference: ctx.orderReference, listingTitle: ctx.listingTitle, ...extraVars },
    })
  }
}

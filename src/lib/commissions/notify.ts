import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate, loadUnityCommissionEmailContext } from '@/lib/email'

/** Sends one commission-lifecycle event to the merchant. Mirrors src/lib/affiliate/notify.ts's notifyAffiliateOfCommission() shape exactly. */
export async function notifyMerchantOfUnityCommission(
  admin: SupabaseClient,
  commissionId: string,
  eventType: string,
  templateId: string,
  extraVars: Record<string, string | number> = {}
): Promise<void> {
  const ctx = await loadUnityCommissionEmailContext(admin, commissionId)
  if (!ctx) return

  await sendTemplate(admin, {
    eventType,
    templateId,
    recipientUserId: ctx.merchantId,
    relatedEntityType: 'unity_commission',
    relatedEntityId: commissionId,
    occurrenceKey: `unity-commission-${commissionId}-${eventType}-${ctx.merchantId}`,
    vars: {
      recipientName: ctx.merchantName,
      listingTitle: ctx.listingTitle,
      commissionAmount: `R${ctx.commissionAmount.toFixed(2)}`,
      transactionReference: ctx.transactionReference,
      ...extraVars,
    },
  })
}

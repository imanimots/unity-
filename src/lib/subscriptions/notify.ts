import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate } from '@/lib/email'

/**
 * Sends one subscription-lifecycle email to the owning merchant.
 * Mirrors src/lib/payouts/notify.ts's single-recipient shape, but takes
 * an explicit eventType/templateId per call site (like
 * src/lib/barter/notify.ts's notifyBarterParty) rather than an internal
 * category map -- request-time "downgrade scheduled" and apply-time
 * "downgrade now in effect" both carry the RPC's own change_category of
 * 'downgrade' but need different wording, so the category alone can't
 * drive template selection.
 *
 * `occurrenceKey` is caller-supplied (typically the mutation's own
 * idempotency key, or a deterministic string for the system sweep),
 * never self-generated. Best-effort by design -- every call site wraps
 * this in its own try/catch; the subscription mutation has already
 * committed by the time this runs.
 */
export async function notifyMerchantSubscriptionEvent(
  admin: SupabaseClient,
  merchantId: string,
  eventType: string,
  templateId: string,
  occurrenceKey: string,
  extraVars: Record<string, string | number> = {}
): Promise<void> {
  const { data: profile } = await admin.from('profiles').select('display_name, full_name').eq('id', merchantId).maybeSingle()
  if (!profile) return

  await sendTemplate(admin, {
    eventType,
    templateId,
    recipientUserId: merchantId,
    relatedEntityType: 'merchant_subscription',
    relatedEntityId: merchantId,
    occurrenceKey,
    vars: {
      merchantName: profile.display_name || profile.full_name || 'there',
      ...extraVars,
    },
  })
}

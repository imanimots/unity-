import type { SupabaseClient } from '@supabase/supabase-js'
import { sendTemplate, loadBookingEmailContext } from '@/lib/email'

const EVENT_TEMPLATES: Record<string, string> = {
  'merchant_payout.created': 'merchant-payout-created',
  'merchant_payout.processing': 'merchant-payout-processing',
  'merchant_payout.paid': 'merchant-payout-paid',
  'merchant_payout.failed': 'merchant-payout-failed',
  'merchant_payout.retry_started': 'merchant-payout-retry-started',
}

/**
 * Sends one payout-lifecycle email to the owning merchant. `occurrenceKey`
 * is caller-supplied (typically the mutation's own idempotency key), never
 * self-generated -- a self-generated timestamp would defeat route-retry
 * idempotency by minting a different key on every retry, the exact bug
 * caught and fixed for the equivalent affiliate notify helper in Phase 7.
 * Best-effort by design -- every call site wraps this in its own
 * try/catch and never lets an email failure affect the payout transition,
 * which has already committed by the time this runs.
 */
export async function notifyMerchantPayoutEvent(
  admin: SupabaseClient,
  payoutId: string,
  eventType: keyof typeof EVENT_TEMPLATES,
  occurrenceKey?: string,
  extraVars?: Record<string, string>
): Promise<void> {
  const templateId = EVENT_TEMPLATES[eventType]
  if (!templateId) return

  const { data: payout } = await admin
    .from('merchant_payouts')
    .select('id, booking_id, merchant_id, amount, currency, status, provider_reference, failure_message_safe')
    .eq('id', payoutId)
    .maybeSingle()
  if (!payout || !payout.booking_id) return

  const bookingCtx = await loadBookingEmailContext(admin, payout.booking_id)
  if (!bookingCtx) return

  await sendTemplate(admin, {
    eventType,
    templateId,
    recipientUserId: payout.merchant_id,
    relatedEntityType: 'merchant_payout',
    relatedEntityId: payoutId,
    occurrenceKey: occurrenceKey ?? '',
    vars: {
      merchantName: bookingCtx.merchantName,
      listingTitle: bookingCtx.listingTitle,
      bookingReference: bookingCtx.bookingReference,
      payoutAmount: `R${Number(payout.amount).toFixed(2)}`,
      currency: 'ZAR',
      payoutReference: payout.provider_reference ?? '',
      failureMessage: payout.failure_message_safe ?? '',
      ...extraVars,
    },
  })
}

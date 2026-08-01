import type { SupabaseClient } from '@supabase/supabase-js'

export interface LateSuccessCheckResult {
  lateSuccess: boolean
}

/**
 * Called immediately after a successful authorizeBookingFinancials() call
 * (checkout route and the webhook reconciliation path) to detect the race
 * where a booking's payment deadline expired *while* the financial
 * authorization was in flight -- the booking is now 'expired' even though
 * the payment just succeeded. Per Step 6's "late provider events" rule:
 * the booking must never be silently reactivated, and the situation must
 * never be silently discarded either. The smallest possible extension:
 * record one booking_history marker (via the idempotent
 * record_late_payment_reconciliation RPC) flagging it for manual review --
 * no refund is issued, no status changes, no ledger write. The payment
 * itself is already durably correct (captured/authorised) via the
 * unchanged Financial Orchestrator; this only marks that a human needs to
 * look at it.
 */
export async function checkAndRecordLateSuccessIfExpired(admin: SupabaseClient, bookingId: string): Promise<LateSuccessCheckResult> {
  const { data: booking } = await admin
    .from('bookings')
    .select('status, payment_expired_at')
    .eq('id', bookingId)
    .maybeSingle()

  if (!booking || booking.status !== 'expired' || !booking.payment_expired_at) {
    return { lateSuccess: false }
  }

  await admin.rpc('record_late_payment_reconciliation', {
    p_booking_id: bookingId,
    p_note: 'Financial authorization completed after the payment deadline expired. Booking remains expired; manual review required for any provider-side reversal.',
  })

  return { lateSuccess: true }
}

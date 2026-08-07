import type { OrchestratorContext, CreateMerchantPayoutResult } from './types'
import { OrchestrationError } from './errors'

/**
 * Derives the payable amount entirely from ledger data -- never a
 * client-supplied figure, never even a parameter on this function.
 * merchant_payouts has no unique constraint on booking_id (a future
 * batched-payout design might legitimately want more than one payout
 * touching a booking), so duplicate prevention for this per-booking
 * payout is an explicit existence check here, not a DB constraint.
 *
 * create_merchant_payout() (20260801000004) already has its own
 * idempotency_keys handling -- reused directly. The duplicate-payout
 * guard below only fires when this ISN'T a legitimate replay: an exact
 * same-key retry must still resolve to the RPC's cached result, not the
 * "a payout already exists" error.
 *
 * Step 11 Phase 8: this function creates the PENDING OBLIGATION only --
 * it must never call a payout provider (mock or real). Creating a
 * payout and processing/paying it out are separate lifecycle events;
 * provider invocation belongs only to a future, explicitly approved
 * processing integration. This is also why the duplicate-payout guard
 * no longer excludes 'failed' payouts (was `.neq('status', 'failed')`)
 * -- once Phase 8's retry_payout() RPC exists (failed -> processing on
 * the SAME row), a failed payout is never superseded by a fresh row
 * here; it is retried in place.
 */
export async function createMerchantPayout(
  ctx: OrchestratorContext,
  bookingId: string,
  idempotencyKey?: string
): Promise<CreateMerchantPayoutResult> {
  const { admin } = ctx

  const { data: booking } = await admin.from('bookings').select('id, merchant_id, status').eq('id', bookingId).maybeSingle()
  if (!booking) throw new OrchestrationError('missing_payment', 'Booking not found')

  const { data: existingPayout } = await admin
    .from('merchant_payouts')
    .select('id, status, idempotency_key')
    .eq('booking_id', bookingId)
    .maybeSingle()

  const isMatchingReplay = existingPayout && idempotencyKey && existingPayout.idempotency_key === idempotencyKey
  if (existingPayout && !isMatchingReplay) {
    throw new OrchestrationError('duplicate_workflow_conflict', 'A payout already exists for this booking')
  }

  const { data: rentalPayment } = await admin
    .from('payments')
    .select('id, status')
    .eq('booking_id', bookingId)
    .eq('payment_type', 'rental_charge')
    .maybeSingle()

  if (!rentalPayment || rentalPayment.status !== 'captured') {
    throw new OrchestrationError('payout_unavailable', 'Rental charge has not been captured for this booking yet')
  }

  const { data: ledgerRows } = await admin.from('ledger_entries').select('entry_type, amount').eq('booking_id', bookingId)

  const sumBy = (type: string) => (ledgerRows ?? []).filter((r) => r.entry_type === type).reduce((sum, r) => sum + Number(r.amount), 0)
  const rentalCharge = sumBy('rental_charge')
  const platformFee = sumBy('platform_fee')
  const refunded = sumBy('refund')
  const payableAmount = round2(rentalCharge - platformFee - refunded)

  if (payableAmount <= 0) {
    throw new OrchestrationError('payout_unavailable', 'No merchant proceeds are available to pay out for this booking')
  }

  const { data, error } = await admin.rpc('create_merchant_payout', {
    p_merchant_id: booking.merchant_id,
    p_booking_id: bookingId,
    p_amount: payableAmount,
    p_idempotency_key: idempotencyKey ?? null,
  })

  if (error) {
    if (error.message.includes('idempotency key already used')) {
      throw new OrchestrationError('duplicate_workflow_conflict', 'This payout request was already submitted with different data')
    }
    throw new OrchestrationError('internal_consistency_error', error.message)
  }

  return { payoutId: data.payout_id, amount: payableAmount, status: 'pending' }
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

import type { OrchestratorContext, CaptureDepositResult } from './types'
import { OrchestrationError } from './errors'
import { getPaymentProvider } from '../registry'

const ELIGIBLE_BOOKING_STATUSES = ['active', 'return_pending', 'returned', 'completed']

/**
 * Domain workflow only -- not exposed to ordinary users this pass (no
 * safe existing admin boundary exists yet to gate it behind; a future
 * admin/dispute-resolution phase is the intended caller). Requires a
 * trusted server-side reason and amount -- there is no code path here
 * that accepts either from an unauthenticated or ordinary-user request.
 *
 * Uses capture_deposit_amount() (20260802000003), a narrowly-scoped
 * addition to the financial domain -- transition_payment_status() alone
 * cannot correctly ledger-record a *partial* capture amount (it always
 * used the payment's full amount, which was never wrong until a genuine
 * partial capture like this one needed to exist). See
 * docs/FINANCIAL_ORCHESTRATION.md.
 *
 * Preserves an explicit extension point for disputes/damage claims: the
 * `reason` parameter is already plumbed through to payment_events and
 * ledger_entries' reference-adjacent metadata, ready for a future
 * dispute record to attach evidence to without any schema change here.
 */
export async function captureDeposit(
  ctx: OrchestratorContext,
  bookingId: string,
  amount: number,
  reason: string,
  idempotencyKey?: string
): Promise<CaptureDepositResult> {
  const { admin, providerName = 'mock' } = ctx
  const provider = getPaymentProvider(providerName)

  if (!(amount > 0)) {
    throw new OrchestrationError('insufficient_deposit_authorization', 'Capture amount must be positive')
  }
  if (!reason || !reason.trim()) {
    throw new OrchestrationError('internal_consistency_error', 'A capture reason is required')
  }

  const { data: booking } = await admin.from('bookings').select('id, status').eq('id', bookingId).maybeSingle()
  if (!booking) throw new OrchestrationError('missing_payment', 'Booking not found')
  if (!ELIGIBLE_BOOKING_STATUSES.includes(booking.status)) {
    throw new OrchestrationError('invalid_booking_state', `Booking status "${booking.status}" is not eligible for deposit capture`)
  }

  const { data: deposit } = await admin
    .from('payments')
    .select('id, status, provider_reference')
    .eq('booking_id', bookingId)
    .eq('payment_type', 'deposit')
    .maybeSingle()

  if (!deposit) throw new OrchestrationError('missing_payment', 'No deposit payment exists for this booking')
  if (deposit.status !== 'authorised' && deposit.status !== 'partially_captured') {
    throw new OrchestrationError('invalid_payment_transition', `Deposit payment is "${deposit.status}", not eligible for capture`)
  }

  const captureResult = await provider.captureDeposit({ paymentId: deposit.id, providerReference: deposit.provider_reference ?? '', amount, currency: 'ZAR' })

  const { data, error } = await admin.rpc('capture_deposit_amount', {
    p_payment_id: deposit.id,
    p_amount: amount,
    p_provider_reference: captureResult.providerReference,
    p_reason: reason,
    p_idempotency_key: idempotencyKey ?? null,
  })

  if (error) {
    if (error.message.includes('exceeds the remaining')) {
      throw new OrchestrationError('insufficient_deposit_authorization', 'Capture amount exceeds the remaining authorized deposit amount')
    }
    if (error.message.includes('idempotency key already used')) {
      throw new OrchestrationError('duplicate_workflow_conflict', 'This capture request was already submitted with different data')
    }
    throw new OrchestrationError('invalid_payment_transition', error.message)
  }

  return {
    paymentId: deposit.id,
    status: data.status,
    capturedAmount: data.captured_amount,
    releasedAmount: data.remaining_amount,
  }
}

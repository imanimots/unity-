import type { OrchestratorContext, ReleaseDepositResult } from './types'
import { OrchestrationError } from './errors'
import { checkIdempotentReplay, computeReleaseDepositHash } from './idempotency'
import { getPaymentProvider } from '../registry'

const ELIGIBLE_BOOKING_STATUSES = ['returned', 'completed']

/**
 * Single provider call (release), single payment transition -- unlike
 * authorize-booking-financials this doesn't need financial_workflows;
 * the existing idempotency_keys pattern (same as every other
 * single-step payment RPC) is sufficient. Only releases a deposit that
 * is still fully 'authorised' -- nothing has been captured against it.
 * Releasing the remainder after a partial capture is capture-deposit's
 * concern, not duplicated here.
 *
 * Resumable primarily via the payment's own status, not just the
 * idempotency key: if a prior call already transitioned the payment to
 * 'released' but the response never reached the caller (crash, network
 * loss), a retry -- with or without a matching key -- short-circuits on
 * that fact rather than erroring on "not authorised".
 */
export async function releaseDeposit(ctx: OrchestratorContext, bookingId: string, idempotencyKey?: string): Promise<ReleaseDepositResult> {
  const { admin, providerName = 'mock' } = ctx
  const provider = getPaymentProvider(providerName)

  const { data: booking } = await admin.from('bookings').select('id, status').eq('id', bookingId).maybeSingle()
  if (!booking) throw new OrchestrationError('missing_payment', 'Booking not found')
  if (!ELIGIBLE_BOOKING_STATUSES.includes(booking.status)) {
    throw new OrchestrationError('invalid_booking_state', `Booking status "${booking.status}" is not eligible for deposit release`)
  }

  const { data: deposit } = await admin
    .from('payments')
    .select('id, status, provider_reference, renter_id')
    .eq('booking_id', bookingId)
    .eq('payment_type', 'deposit')
    .maybeSingle()

  if (!deposit) throw new OrchestrationError('missing_payment', 'No deposit payment exists for this booking')

  if (deposit.status === 'released') {
    return { paymentId: deposit.id, status: 'released' }
  }

  const hash = computeReleaseDepositHash(deposit.id)
  if (idempotencyKey) {
    const replay = await checkIdempotentReplay(admin, deposit.renter_id, 'orchestrator_release_deposit', idempotencyKey, hash)
    if (replay.status === 'replay') return replay.result as ReleaseDepositResult
    if (replay.status === 'conflict') throw new OrchestrationError('duplicate_workflow_conflict', 'This release request was already submitted with different data')
  }

  if (deposit.status !== 'authorised') {
    throw new OrchestrationError('invalid_payment_transition', `Deposit payment is "${deposit.status}", not eligible for release`)
  }

  const released = await provider.releaseDeposit({ paymentId: deposit.id, providerReference: deposit.provider_reference ?? '', amount: 0, currency: 'ZAR' })

  const { error } = await admin.rpc('transition_payment_status', {
    p_payment_id: deposit.id,
    p_new_status: 'released',
    p_provider_reference: released.providerReference,
    p_actor_type: 'system',
  })
  if (error) throw new OrchestrationError('invalid_payment_transition', error.message)

  const result: ReleaseDepositResult = { paymentId: deposit.id, status: 'released' }

  if (idempotencyKey) {
    await admin.from('idempotency_keys').insert({
      merchant_id: deposit.renter_id,
      operation: 'orchestrator_release_deposit',
      idempotency_key: idempotencyKey,
      request_hash: hash,
      result,
    })
  }

  return result
}

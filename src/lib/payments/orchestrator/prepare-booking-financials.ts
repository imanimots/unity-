import type { OrchestratorContext, PrepareBookingFinancialsResult } from './types'
import { OrchestrationError } from './errors'

const ELIGIBLE_BOOKING_STATUSES = ['accepted', 'active', 'return_pending', 'returned', 'completed']

/**
 * Ensures the rental-charge payment (and, if the booking snapshot
 * requires a deposit, the deposit payment) exist for a booking. Never
 * calls a provider -- this only creates the payment *records* financial
 * workflows act on. Amounts are always read from the booking's own
 * immutable financial snapshot (src/lib/bookings/price.ts /
 * create_booking_request()) -- there is no amount parameter on this
 * function at all, so a caller cannot supply one even by mistake.
 *
 * Idempotent by construction: payments.payments_booking_type_unique
 * (one row per booking_id + payment_type) means calling this twice for
 * the same booking always resolves to the same two payment ids, whether
 * or not create_payment_intent's own idempotency_keys replay fires.
 */
export async function prepareBookingFinancials(
  ctx: OrchestratorContext,
  bookingId: string,
  idempotencyKey?: string
): Promise<PrepareBookingFinancialsResult> {
  const { admin } = ctx
  const providerName = ctx.providerName || process.env.PAYMENT_PROVIDER || 'mock'

  const { data: booking, error: bookingError } = await admin
    .from('bookings')
    .select('id, status, subtotal_amount, deposit_amount_snapshot')
    .eq('id', bookingId)
    .maybeSingle()

  if (bookingError || !booking) {
    throw new OrchestrationError('missing_payment', 'Booking not found')
  }
  if (!ELIGIBLE_BOOKING_STATUSES.includes(booking.status)) {
    throw new OrchestrationError('invalid_booking_state', `Booking status "${booking.status}" is not eligible to prepare financials`)
  }

  const rentalPaymentId = await getOrCreatePayment(
    admin,
    bookingId,
    'rental_charge',
    booking.subtotal_amount,
    providerName,
    idempotencyKey ? `${idempotencyKey}-rental` : undefined
  )

  let depositPaymentId: string | null = null
  if (booking.deposit_amount_snapshot > 0) {
    depositPaymentId = await getOrCreatePayment(
      admin,
      bookingId,
      'deposit',
      booking.deposit_amount_snapshot,
      providerName,
      idempotencyKey ? `${idempotencyKey}-deposit` : undefined
    )
  }

  return { rentalPaymentId, depositPaymentId }
}

async function getOrCreatePayment(
  admin: OrchestratorContext['admin'],
  bookingId: string,
  paymentType: 'rental_charge' | 'deposit',
  amount: number,
  provider: string,
  idempotencyKey: string | undefined
): Promise<string> {
  const { data: existing } = await admin
    .from('payments')
    .select('id')
    .eq('booking_id', bookingId)
    .eq('payment_type', paymentType)
    .maybeSingle()

  if (existing) return existing.id

  const { data, error } = await admin.rpc('create_payment_intent', {
    p_booking_id: bookingId,
    p_payment_type: paymentType,
    p_amount: amount,
    p_currency: 'ZAR',
    p_provider: provider,
    p_idempotency_key: idempotencyKey ?? null,
  })

  if (error) {
    throw new OrchestrationError('internal_consistency_error', `Could not create ${paymentType} payment: ${error.message}`)
  }
  return data.payment_id
}

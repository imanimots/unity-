/**
 * Maps known RAISE EXCEPTION messages from the payment RPCs
 * (supabase/migrations/20260801000004_payment_rpcs.sql) to a user-safe
 * message + HTTP status. Same convention as
 * src/lib/bookings/rpc-errors.ts and src/lib/listings/rpc-errors.ts --
 * never forward a raw Postgres error to the client.
 */
export function mapPaymentRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('invalid amount') || m.includes('invalid refund amount') || m.includes('invalid payout amount')) {
    return { status: 400, error: 'Invalid amount.' }
  }
  if (m.includes('booking not found')) {
    return { status: 404, error: 'Booking not found.' }
  }
  if (m.includes('payment not found')) {
    return { status: 404, error: 'Payment not found.' }
  }
  if (m.includes('invalid payment status transition')) {
    return { status: 409, error: 'This payment cannot move to that state right now.' }
  }
  if (m.includes('payment is not in a refundable status')) {
    return { status: 409, error: 'This payment cannot be refunded in its current state.' }
  }
  if (m.includes('refund amount exceeds')) {
    return { status: 422, error: 'The refund amount exceeds what is available to refund.' }
  }
  if (m.includes('invalid actor_type')) {
    return { status: 400, error: 'Invalid request.' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process this request — please try again' }
  }

  return { status: 500, error: 'Could not process this request — please try again' }
}

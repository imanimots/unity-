/**
 * Maps known RAISE EXCEPTION messages from the dispute RPCs
 * (supabase/migrations/20260814000006_dispute_rpcs.sql) to a user-safe
 * message + HTTP status. Same convention as src/lib/orders/rpc-errors.ts
 * -- substring .includes() matching, never forward a raw Postgres error
 * to the client.
 */
export function mapDisputeRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated') || m.includes('you must be signed in')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('exactly one of booking_id, order_id, or barter_agreement_id')) {
    return { status: 400, error: 'A dispute must reference exactly one booking, order, or barter trade.' }
  }
  if (m.includes('title is required') || m.includes('description is required') || m.includes('requested resolution is required')) {
    return { status: 400, error: 'Please fill in every required field.' }
  }
  if (m.includes('booking not found')) {
    return { status: 404, error: 'Booking not found.' }
  }
  if (m.includes('order not found')) {
    return { status: 404, error: 'Order not found.' }
  }
  if (m.includes('barter agreement not found')) {
    return { status: 404, error: 'Trade not found.' }
  }
  if (m.includes('raiser is not a party to this')) {
    return { status: 403, error: 'You are not a party to this transaction.' }
  }
  if (m.includes('a dispute is already open for this')) {
    return { status: 409, error: 'A dispute is already open for this transaction.' }
  }
  if (m.includes('dispute not found')) {
    return { status: 404, error: 'Dispute not found.' }
  }
  if (m.includes('assignee must be an admin')) {
    return { status: 400, error: 'The assignee must be an admin.' }
  }
  if (m.includes('this dispute is no longer active')) {
    return { status: 409, error: 'This dispute is no longer active.' }
  }
  if (m.includes('this dispute is not ready to move into review')) {
    return { status: 409, error: 'This dispute is not ready to move into review.' }
  }
  if (m.includes('evidence can only be requested while a dispute is open or under review')) {
    return { status: 409, error: 'Evidence can only be requested while a dispute is open or under review.' }
  }
  if (m.includes('invalid outcome')) {
    return { status: 400, error: 'Invalid resolution outcome.' }
  }
  if (m.includes('a dispute can only be resolved while under review')) {
    return { status: 409, error: 'A dispute can only be resolved while it is under review.' }
  }
  if (m.includes('a dispute can only be closed after it has been resolved')) {
    return { status: 409, error: 'A dispute can only be closed after it has been resolved.' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

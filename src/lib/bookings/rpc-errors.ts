/**
 * Maps known RAISE EXCEPTION messages from the booking RPCs
 * (supabase/migrations/20260730000007_booking_rpcs.sql) to a user-safe
 * message + HTTP status. Same convention as
 * src/lib/listings/rpc-errors.ts -- never forward a raw Postgres error to
 * the client. The raw error is still logged server-side by the caller
 * before this runs.
 */
export function mapBookingRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('end time must be after start time')) {
    return { status: 400, error: 'The end time must be after the start time.' }
  }
  if (m.includes('start time must be in the future')) {
    return { status: 400, error: 'The start time must be in the future.' }
  }
  if (m.includes('listing not found or not available for booking')) {
    return { status: 404, error: 'This listing is not available for booking.' }
  }
  if (m.includes('you cannot book your own listing')) {
    return { status: 403, error: 'You cannot book your own listing.' }
  }
  if (m.includes('verification_required:counterparty')) {
    return { status: 403, error: 'This listing is not currently available for a new transaction.' }
  }
  if (m.includes('verification_required:self')) {
    return { status: 403, error: 'You need to complete verification before doing this.' }
  }
  if (m.includes('currently committed to a barter agreement')) {
    return { status: 409, error: 'This listing is currently committed to a barter agreement and cannot be booked.' }
  }
  if (m.includes('currently committed to a rent-to-buy agreement')) {
    return { status: 409, error: 'This listing is currently committed to a rent-to-buy agreement and cannot be booked.' }
  }
  if (m.includes('below the minimum rental period')) {
    return { status: 422, error: 'The requested duration is below this listing’s minimum rental period.' }
  }
  if (m.includes('exceeds the maximum rental period')) {
    return { status: 422, error: 'The requested duration exceeds this listing’s maximum rental period.' }
  }
  if (m.includes('requires at least') && m.includes('advance notice')) {
    return { status: 422, error: 'This listing requires more advance notice for the requested start date.' }
  }
  if (m.includes('cannot be booked more than') && m.includes('advance')) {
    return { status: 422, error: 'This listing cannot be booked this far in advance.' }
  }
  if (m.includes('merchant has marked unavailable')) {
    return { status: 409, error: 'The requested dates are unavailable for this listing.' }
  }
  if (
    m.includes('no longer available for the requested dates') ||
    m.includes('no longer available for these dates') ||
    m.includes('requested dates are no longer available')
  ) {
    return { status: 409, error: 'The requested dates are no longer available for this listing.' }
  }
  if (m.includes('this request has expired')) {
    return { status: 409, error: 'This booking request has expired and can no longer be accepted.' }
  }
  if (m.includes('not in requested status')) {
    return { status: 409, error: 'This booking is no longer in a requested state.' }
  }
  if (m.includes('not in accepted status')) {
    return { status: 409, error: 'This booking is not in an accepted state.' }
  }
  if (m.includes('not in active status')) {
    return { status: 409, error: 'This booking is not active.' }
  }
  if (m.includes('not in return_pending status')) {
    return { status: 409, error: 'This booking is not awaiting return confirmation.' }
  }
  if (m.includes('too early to start this rental')) {
    return { status: 422, error: 'It is too early to start this rental.' }
  }
  if (m.includes('rental window has already passed')) {
    return { status: 422, error: 'This booking’s rental window has already passed.' }
  }
  if (m.includes('the other party must confirm the return')) {
    return { status: 403, error: 'The other party must confirm the return.' }
  }
  if (m.includes('not a party to it')) {
    return { status: 404, error: 'Booking not found.' }
  }
  if (m.includes('cancellation notice period')) {
    return { status: 422, error: 'The cancellation notice period for this booking has passed.' }
  }
  if (m.includes('use reject for a requested booking')) {
    return { status: 400, error: 'Use reject, not cancel, for a booking that has not yet been accepted.' }
  }
  if (m.includes('administrative process')) {
    return { status: 403, error: 'Active bookings cannot be self-cancelled.' }
  }
  if (m.includes('cannot be cancelled in its current status')) {
    return { status: 409, error: 'This booking cannot be cancelled in its current state.' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

/**
 * Maps known RAISE EXCEPTION messages from the barter RPCs
 * (supabase/migrations/20260810000011_barter_rpcs_phase_a.sql) to a
 * user-safe message + HTTP status. Same convention as
 * src/lib/bookings/rpc-errors.ts -- substring .includes() matching (never
 * regex, never exact equality, since Postgres interpolates parameters
 * into some messages), never forward a raw Postgres error to the client.
 * The raw error is still logged server-side by the caller before this
 * runs.
 */
export function mapBarterRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('invalid expiry window')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }
  if (m.includes('at least one listing must be offered')) {
    return { status: 422, error: 'At least one listing must be offered from each side of the trade.' }
  }
  if (m.includes('the same listing cannot be offered more than once')) {
    return { status: 422, error: 'The same listing cannot be offered more than once.' }
  }
  if (m.includes('one or more offered listings could not be found')) {
    return { status: 404, error: 'One or more offered listings could not be found.' }
  }
  if (m.includes('does not belong to that party')) {
    return { status: 403, error: 'One or more offered listings do not belong to the party offering them.' }
  }
  if (m.includes('not yet active')) {
    return { status: 422, error: 'One or more offered listings are not yet active and cannot be included in a trade.' }
  }
  if (m.includes('currently committed to another barter agreement')) {
    return { status: 409, error: 'One or more offered listings are currently committed to another barter agreement.' }
  }
  if (m.includes('currently committed to a rent-to-buy agreement')) {
    return { status: 409, error: 'One or more offered listings are currently committed to a rent-to-buy agreement.' }
  }
  if (m.includes('this listing is not available for barter')) {
    return { status: 404, error: 'This listing is not available for barter.' }
  }
  if (m.includes('you cannot propose a trade on your own listing')) {
    return { status: 403, error: 'You cannot propose a trade on your own listing.' }
  }
  if (m.includes('verification_required:counterparty')) {
    return { status: 403, error: 'This listing is not currently available for a new transaction.' }
  }
  if (m.includes('verification_required:self')) {
    return { status: 403, error: 'You need to complete verification before doing this.' }
  }
  if (m.includes('barter agreement not found or you are not a party to it')) {
    return { status: 404, error: 'Barter agreement not found.' }
  }
  if (m.includes('currently suspended by an administrator')) {
    return { status: 403, error: 'This barter agreement is currently suspended by an administrator.' }
  }
  if (m.includes('this offer can no longer be countered')) {
    return { status: 409, error: 'This offer can no longer be countered.' }
  }
  if (m.includes('this offer can no longer be accepted')) {
    return { status: 409, error: 'This offer can no longer be accepted.' }
  }
  if (m.includes('this offer can no longer be rejected')) {
    return { status: 409, error: 'This offer can no longer be rejected.' }
  }
  if (m.includes('it is not your turn to respond to this offer')) {
    return { status: 403, error: 'It is not your turn to respond to this offer.' }
  }
  if (m.includes('cannot cancel a disputed agreement')) {
    return { status: 409, error: 'A disputed agreement cannot be cancelled — it must be resolved first.' }
  }
  if (m.includes('cannot be cancelled in its current status')) {
    return { status: 409, error: 'This agreement cannot be cancelled in its current state.' }
  }
  if (m.includes('listing not found')) {
    return { status: 404, error: 'Listing not found.' }
  }
  if (m.includes('this agreement is currently disputed and cannot progress')) {
    return { status: 409, error: 'This agreement is currently disputed — it must be resolved before it can progress.' }
  }
  if (m.includes('this agreement is currently disputed and cannot be completed')) {
    return { status: 409, error: 'This agreement is currently disputed — it must be resolved before it can be completed.' }
  }
  if (m.includes('this agreement is not yet financially ready to proceed')) {
    return { status: 409, error: 'This agreement is not yet financially ready to proceed — every required payment must be completed first.' }
  }
  if (m.includes('this delivery method does not use an in-transit step')) {
    return { status: 409, error: 'This delivery method does not use an in-transit step.' }
  }
  if (m.includes('this delivery method requires marking the item in transit first')) {
    return { status: 409, error: 'This delivery method requires marking the item in transit first.' }
  }
  if (m.includes('this transition is not allowed from the agreement')) {
    return { status: 409, error: 'This transition is not allowed from the agreement’s current status.' }
  }
  if (m.includes('this agreement is not yet awaiting completion confirmation')) {
    return { status: 409, error: 'This agreement is not yet ready for completion confirmation.' }
  }
  if (m.includes('invalid payment type for a barter payment intent')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

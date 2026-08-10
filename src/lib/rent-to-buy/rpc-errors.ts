/**
 * Maps known RAISE EXCEPTION messages from the rent-to-buy RPCs
 * (supabase/migrations/20260827000005_rtb_rpcs.sql) to a user-safe
 * message + HTTP status. Same substring .includes() convention as
 * src/lib/marketplace/rpc-errors.ts -- never regex, never exact equality.
 */
export function mapRentToBuyRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) return { status: 401, error: 'You must be signed in.' }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('verification_required')) return { status: 403, error: 'Both parties need to complete verification before this can proceed.' }
  if (m.includes('listing not found')) return { status: 404, error: 'Listing not found.' }
  if (m.includes('not the owner of this listing')) return { status: 403, error: 'You are not the owner of this listing.' }
  if (m.includes('invalid terms')) return { status: 422, error: 'Invalid rent-to-buy terms.' }
  if (m.includes('cannot enter a rent-to-buy agreement on your own listing')) return { status: 403, error: 'You cannot enter a rent-to-buy agreement on your own listing.' }
  if (m.includes('listing is not currently active')) return { status: 422, error: 'That listing is not currently active.' }
  if (m.includes('this listing does not have rent-to-buy enabled')) return { status: 422, error: 'This listing does not have rent-to-buy enabled.' }
  if (m.includes('this listing is currently committed to a barter agreement')) return { status: 409, error: 'This listing is currently committed to a barter agreement.' }
  if (m.includes('this listing is currently committed to another rent-to-buy agreement')) return { status: 409, error: 'This listing is currently committed to another rent-to-buy agreement.' }
  if (m.includes('this listing currently has an active rental booking')) return { status: 409, error: 'This listing currently has an active rental booking.' }
  if (m.includes('this listing has no remaining inventory available')) return { status: 409, error: 'This listing has no remaining inventory available.' }
  if (m.includes('agreement not found')) return { status: 404, error: 'Agreement not found.' }
  if (m.includes('not the merchant of this agreement')) return { status: 403, error: 'You are not the merchant of this agreement.' }
  if (m.includes('not the customer of this agreement')) return { status: 403, error: 'You are not the customer of this agreement.' }
  if (m.includes('not a party to this agreement')) return { status: 403, error: 'You are not a party to this agreement.' }
  if (m.includes('cannot be accepted from here')) return { status: 409, error: 'This agreement cannot be accepted from its current status.' }
  if (m.includes('cannot be declined from here')) return { status: 409, error: 'This agreement cannot be declined from its current status.' }
  if (m.includes('cannot be cancelled from here')) return { status: 409, error: 'This agreement cannot be cancelled from its current status.' }
  if (m.includes('cannot be confirmed from here')) return { status: 409, error: 'Possession cannot be confirmed from its current status.' }
  if (m.includes('agreement is disputed')) return { status: 409, error: 'This agreement has an open dispute.' }
  if (m.includes('agreement is cancelled')) return { status: 409, error: 'This agreement is cancelled.' }
  if (m.includes('installment not found')) return { status: 404, error: 'Installment not found.' }
  if (m.includes('cannot be marked defaulted from here')) return { status: 409, error: 'This agreement cannot be marked defaulted from its current status.' }
  if (m.includes('ownership has already transferred')) return { status: 409, error: 'Ownership has already transferred for this agreement.' }
  if (m.includes('cure is not allowed')) return { status: 403, error: 'Cure is not allowed under this agreement.' }
  if (m.includes('is not eligible for cure')) return { status: 409, error: 'This agreement is not eligible for cure.' }
  if (m.includes('already reached a terminal return/recovery state')) return { status: 409, error: 'The item has already reached a terminal return/recovery state.' }
  if (m.includes('early payoff is not allowed')) return { status: 403, error: 'Early payoff is not allowed under this agreement.' }
  if (m.includes('is not eligible for payoff')) return { status: 409, error: 'This agreement is not eligible for payoff.' }
  if (m.includes('no remaining balance')) return { status: 409, error: 'There is no remaining balance to pay off.' }
  if (m.includes('a return cannot be requested from here')) return { status: 409, error: 'A return cannot be requested from the current possession status.' }
  if (m.includes('return case not found')) return { status: 404, error: 'Return case not found.' }
  if (m.includes('cannot be confirmed returned from here')) return { status: 409, error: 'This case cannot be confirmed returned from its current status.' }
  if (m.includes('not eligible for a recovery case')) return { status: 409, error: 'This agreement is not eligible for a recovery case.' }
  if (m.includes('this case is not a recovery case')) return { status: 422, error: 'This case is not a recovery case.' }
  if (m.includes('cannot be marked recovered from here')) return { status: 409, error: 'This case cannot be marked recovered from its current status.' }
  if (m.includes('a reason is required')) return { status: 422, error: 'A reason is required.' }
  if (m.includes('this agreement has no security deposit configured')) return { status: 422, error: 'This agreement has no security deposit configured.' }
  if (m.includes('not authorized')) return { status: 500, error: 'Could not process your request — please try again' }

  return { status: 500, error: 'Could not process your request — please try again' }
}

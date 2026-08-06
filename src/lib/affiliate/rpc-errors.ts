/**
 * Maps known RAISE EXCEPTION messages from the affiliate RPCs
 * (supabase/migrations/20260819000008_affiliate_rpcs.sql) to a
 * user-safe message + HTTP status. Same convention as
 * src/lib/orders/rpc-errors.ts -- substring .includes() matching,
 * never forward a raw Postgres error to the client.
 */
export function mapAffiliateRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('invalid or inactive affiliate code')) {
    return { status: 404, error: 'This affiliate link is not valid.' }
  }
  if (m.includes('listing not found or not active')) {
    return { status: 404, error: 'This listing is not available.' }
  }
  if (m.includes('does not accept affiliate referrals')) {
    return { status: 400, error: 'This listing does not accept affiliate referrals.' }
  }
  if (m.includes('does not support a commissionable transaction type')) {
    return { status: 400, error: 'This listing does not support a commissionable transaction.' }
  }
  if (m.includes('self-referral is not permitted')) {
    return { status: 403, error: 'You cannot use your own affiliate link.' }
  }
  if (m.includes('cannot be their own listing') || m.includes('cannot be referred as a customer')) {
    return { status: 403, error: 'This referral is not permitted.' }
  }
  if (m.includes('listing not found')) {
    return { status: 404, error: 'Listing not found.' }
  }
  if (m.includes('you do not own this listing')) {
    return { status: 403, error: 'You do not own this listing.' }
  }
  if (m.includes('a reason is required')) {
    return { status: 400, error: 'A reason is required for this action.' }
  }
  if (m.includes('commission not found')) {
    return { status: 404, error: 'Commission not found.' }
  }
  if (m.includes('cannot transition to')) {
    return { status: 409, error: 'This commission is not in a state that allows this action.' }
  }
  if (m.includes('invalid actor type') || m.includes('invalid payout result status') || m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

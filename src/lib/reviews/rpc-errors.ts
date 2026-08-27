/**
 * Maps known RAISE EXCEPTION messages from the Reviews V2 RPCs
 * (supabase/migrations/20260904000009_reviews_v2_rpcs.sql) to a
 * user-safe message + HTTP status. Same substring .includes() matching
 * convention as every other *rpc-errors.ts file in this codebase — never
 * a raw Postgres error forwarded to the client.
 */
export function mapReviewsRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('rating must be between 1 and 5')) {
    return { status: 422, error: 'Rating must be between 1 and 5.' }
  }
  if (m.includes('invalid domain')) {
    return { status: 400, error: 'Invalid review type.' }
  }
  if (m.includes('account_suspended:self')) {
    return { status: 403, error: 'Your account cannot do this right now. Contact support if you believe this is a mistake.' }
  }
  if (m.includes('transaction not found')) {
    return { status: 404, error: 'Transaction not found.' }
  }
  if (m.includes('you are not a party to this transaction')) {
    return { status: 403, error: 'You are not a party to this transaction.' }
  }
  if (m.includes('this transaction is not yet eligible for a review')) {
    return { status: 409, error: 'This transaction is not yet eligible for a review.' }
  }
  if (m.includes('the review window for this transaction has expired')) {
    return { status: 409, error: 'The review window for this transaction has expired.' }
  }
  if (m.includes('review not found')) {
    return { status: 404, error: 'Review not found.' }
  }
  if (m.includes('only the reviewed party may reply to this review')) {
    return { status: 403, error: 'Only the reviewed party may reply to this review.' }
  }
  if (m.includes('this review is not yet public')) {
    return { status: 409, error: 'This review is not yet public.' }
  }
  if (m.includes('this review is no longer valid')) {
    return { status: 409, error: 'This review is no longer valid.' }
  }
  if (m.includes('the reply window for this review has expired')) {
    return { status: 409, error: 'The reply window for this review has expired.' }
  }
  if (m.includes('reply text is required')) {
    return { status: 422, error: 'Reply text is required.' }
  }
  if (m.includes('invalid report target')) {
    return { status: 400, error: 'Invalid report target.' }
  }
  if (m.includes('invalid report reason')) {
    return { status: 400, error: 'Invalid report reason.' }
  }
  if (m.includes('only the reviewed party may report this review')) {
    return { status: 403, error: 'Only the reviewed party may report this review.' }
  }
  if (m.includes('only the original reviewer may report this reply')) {
    return { status: 403, error: 'Only the original reviewer may report this reply.' }
  }
  if (m.includes('reply not found')) {
    return { status: 404, error: 'Reply not found.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('a reason is required')) {
    return { status: 400, error: 'A reason is required.' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

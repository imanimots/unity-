/**
 * Maps known RAISE EXCEPTION messages from the merchant payout RPCs
 * (supabase/migrations/20260820000003_merchant_payout_rpcs.sql) to a
 * user-safe message + HTTP status. Same convention as
 * src/lib/affiliate/rpc-errors.ts -- substring .includes() matching,
 * never forward a raw Postgres error to the client.
 */
export function mapPayoutRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('payout not found')) {
    return { status: 404, error: 'Payout not found.' }
  }
  if (m.includes('cannot start processing from here') || m.includes('cannot be retried from here') || m.includes('cannot be marked paid from here') || m.includes('cannot be marked failed from here')) {
    return { status: 409, error: 'This payout is not in a state that allows this action.' }
  }
  if (m.includes('not currently eligible to process') || m.includes('not currently eligible to retry')) {
    return { status: 422, error: 'This payout is not currently eligible to process. Check for an unresolved dispute, refund, or account restriction.' }
  }
  if (m.includes('can no longer be safely marked paid')) {
    return { status: 422, error: 'This payout can no longer be safely marked paid. Check for a new dispute, refund, or account restriction.' }
  }
  if (m.includes('a reason is required')) {
    return { status: 400, error: 'A reason is required for this action.' }
  }
  if (m.includes('manual payment confirmation is required')) {
    return { status: 400, error: 'Manual payment confirmation is required.' }
  }
  if (m.includes('a payout reference is required')) {
    return { status: 400, error: 'A payout reference is required.' }
  }
  if (m.includes('invalid payout method')) {
    return { status: 400, error: 'Invalid payout method.' }
  }
  if (m.includes('invalid failure category')) {
    return { status: 400, error: 'Invalid failure category.' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

/**
 * Maps known RAISE EXCEPTION messages from the Unity commission RPCs
 * (supabase/migrations/20260823000003_unity_commission_calc_and_qualify_rpcs.sql,
 * 20260823000005_unity_commission_lifecycle_rpcs.sql) to a user-safe
 * message + HTTP status. Same convention as
 * src/lib/affiliate/rpc-errors.ts -- substring .includes() matching,
 * never forward a raw Postgres error to the client.
 */
export function mapCommissionRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('commission not found')) {
    return { status: 404, error: 'Commission not found.' }
  }
  if (m.includes('cannot transition to')) {
    return { status: 409, error: 'This commission is not in a state that allows this action.' }
  }
  if (m.includes('a reason is required')) {
    return { status: 400, error: 'A reason is required for this action.' }
  }
  if (m.includes('invalid actor type') || m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

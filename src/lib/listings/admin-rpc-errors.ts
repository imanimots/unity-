/**
 * Maps known RAISE EXCEPTION messages from the admin moderation RPCs
 * (20260803000003_admin_moderation_rpcs.sql) to a user-safe message + HTTP
 * status -- same convention as mapListingRpcError() in rpc-errors.ts.
 * Never forward a raw Postgres error to the client.
 */
export function mapAdminRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('already has a final decision')) {
    return { status: 409, error: 'Ownership verification for this listing already has a final decision.' }
  }
  if (m.includes('listing not found')) {
    return { status: 404, error: 'Listing not found.' }
  }
  if (m.includes('not eligible for activation')) {
    return { status: 409, error: 'This listing is not currently eligible for activation.' }
  }
  if (m.includes('has not been approved by moderation')) {
    return { status: 409, error: 'This listing has not been approved by moderation yet.' }
  }
  if (m.includes('only an active listing can be suspended')) {
    return { status: 409, error: 'Only an active listing can be suspended.' }
  }
  if (m.includes('invalid ownership decision') || m.includes('invalid moderation decision')) {
    return { status: 400, error: 'Invalid decision.' }
  }
  if (m.includes('not authenticated') || m.includes('not authorized')) {
    return { status: 401, error: 'You must be signed in as an administrator.' }
  }

  return { status: 500, error: 'Could not complete this action -- please try again' }
}

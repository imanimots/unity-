/**
 * Maps known RAISE EXCEPTION messages from report_profile()
 * (supabase/migrations/20260830000001_clickable_profiles_report.sql)
 * to a user-safe message + HTTP status. Same substring .includes()
 * convention as every other domain's rpc-errors.ts.
 */
export function mapProfileRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('you cannot report your own profile')) {
    return { status: 403, error: 'You cannot report your own profile.' }
  }
  if (m.includes('invalid report reason')) {
    return { status: 422, error: 'Please choose a valid reason.' }
  }
  if (m.includes('reported profile not found')) {
    return { status: 404, error: 'Profile not found.' }
  }
  if (m.includes('a reported profile is required')) {
    return { status: 400, error: 'Could not process your request — please try again' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

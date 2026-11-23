/**
 * Maps known RAISE EXCEPTION messages from report_listing() /
 * admin_close_listing_report() (supabase/migrations/20261123100000_listing_reports.sql)
 * to a user-safe message + HTTP status. Same substring .includes()
 * matching convention as every other *rpc-errors.ts file in this
 * codebase — never a raw Postgres error forwarded to the client.
 */
export function mapListingReportRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('invalid report reason')) {
    return { status: 400, error: 'Invalid report reason.' }
  }
  if (m.includes('listing not found')) {
    return { status: 404, error: 'Listing not found.' }
  }
  if (m.includes('you cannot report your own listing')) {
    return { status: 403, error: 'You cannot report your own listing.' }
  }
  if (m.includes('invalid report status')) {
    return { status: 400, error: 'Invalid report status.' }
  }
  if (m.includes('report not found or already closed')) {
    return { status: 404, error: 'Report not found or already closed.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

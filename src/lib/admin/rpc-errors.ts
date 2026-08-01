/**
 * Maps known RAISE EXCEPTION messages from the Step 9 admin-operations
 * RPCs (set_user_account_status, add_admin_note, resolve_exception) to a
 * user-safe message + HTTP status — same convention as
 * src/lib/listings/admin-rpc-errors.ts. Never forward a raw Postgres
 * error to the client.
 */
export function mapAdminOperationsRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('cannot restrict or suspend their own account')) {
    return { status: 403, error: 'You cannot restrict or suspend your own account.' }
  }
  if (m.includes('user not found')) {
    return { status: 404, error: 'User not found.' }
  }
  if (m.includes('invalid account status action')) {
    return { status: 400, error: 'Invalid account status action.' }
  }
  if (m.includes('invalid entity type')) {
    return { status: 400, error: 'Invalid note target.' }
  }
  if (m.includes('note cannot be empty')) {
    return { status: 400, error: 'Note cannot be empty.' }
  }
  if (m.includes('not authenticated') || m.includes('not authorized')) {
    return { status: 401, error: 'You must be signed in as an administrator.' }
  }

  return { status: 500, error: 'Could not complete this action — please try again' }
}

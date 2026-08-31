/**
 * Maps known `RAISE EXCEPTION` messages from save_listing_draft() /
 * submit_listing_for_review() (supabase/migrations/20260729000007,
 * 20260729000008) to a user-safe message + HTTP status. Anything
 * unrecognized falls back to a generic message — never forward a raw
 * Postgres error to the client (see docs/LISTING_SCHEMA.md's
 * error-handling notes). The raw error is still logged server-side by
 * the caller before this runs.
 */
export function mapListingRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('invalid or inactive category')) {
    return { status: 400, error: 'Please select a valid category.' }
  }
  if (m.includes('does not belong to the caller')) {
    return { status: 400, error: 'One or more uploaded files could not be verified.' }
  }
  if (m.includes('recurring_unavailable_weekdays must contain only values')) {
    return { status: 400, error: 'Recurring unavailable days must be between Sunday and Saturday.' }
  }
  if (m.includes('blocked date ranges must not overlap')) {
    return { status: 400, error: 'Blocked date ranges must not overlap.' }
  }
  if (m.includes('not found, not owned by caller, or no longer a draft')) {
    return { status: 409, error: 'This listing can no longer be edited — it may have already been submitted.' }
  }
  if (m.includes('not found, not owned by caller, or not in draft status')) {
    return { status: 409, error: 'This listing can no longer be submitted — it may have already been submitted.' }
  }
  if (m.includes('all required declarations must be accepted')) {
    return { status: 422, error: 'All declarations must be accepted before submitting.' }
  }
  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('not authorized')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('listing not found')) {
    return { status: 404, error: 'Listing not found.' }
  }
  if (m.includes('you do not own this listing')) {
    return { status: 403, error: 'You do not own this listing.' }
  }
  if (m.includes('only an active listing can be paused')) {
    return { status: 409, error: 'Only an active listing can be paused.' }
  }
  if (m.includes('only a paused listing can be resumed')) {
    return { status: 409, error: 'Only a paused listing can be resumed.' }
  }
  if (m.includes('active_publication_limit_reached') || m.includes('active_listing_limit_reached')) {
    return { status: 422, error: 'Your current plan has reached its active publication limit. Upgrade your plan or pause another listing to make room.' }
  }
  if (m.includes('publication_frozen_pending_keep_set')) {
    return { status: 409, error: 'Resolve your downgrade selection before resuming this listing.' }
  }
  if (m.includes('affiliate_requires_pro_or_elite')) {
    return { status: 403, error: 'Enabling affiliates requires an active Pro or Elite subscription.' }
  }

  return { status: 500, error: 'Could not save your listing — please try again' }
}

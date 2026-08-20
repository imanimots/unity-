/**
 * Maps known RAISE EXCEPTION messages from the merchant subscription
 * RPCs (supabase/migrations/20260822000003_merchant_subscription_rpcs.sql,
 * supabase/migrations/20260822000004_merchant_subscription_listing_cap.sql)
 * to a user-safe message + HTTP status. Same convention as
 * src/lib/payouts/rpc-errors.ts / src/lib/affiliate/rpc-errors.ts --
 * substring .includes() matching, never forward a raw Postgres error to
 * the client.
 */
export function mapSubscriptionRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('unknown plan')) {
    return { status: 400, error: 'That plan does not exist.' }
  }
  if (m.includes('is not currently available')) {
    return { status: 400, error: 'That plan is not currently available.' }
  }
  if (m.includes('use cancel_pending_merchant_plan_change to undo a scheduled change instead')) {
    return { status: 409, error: 'You are already on this plan. Cancel your pending change instead.' }
  }
  if (m.includes('a successful billing reference is required to upgrade')) {
    return { status: 402, error: 'A successful payment is required to upgrade.' }
  }
  if (m.includes('no pending plan change to cancel')) {
    return { status: 404, error: 'There is no pending plan change to cancel.' }
  }
  if (m.includes('a reason is required for an administrative correction')) {
    return { status: 400, error: 'A reason is required for this action.' }
  }
  if (m.includes('active_publication_limit_reached') || m.includes('active_listing_limit_reached')) {
    return { status: 422, error: 'Your current plan has reached its active publication limit. Upgrade your plan to publish more.' }
  }
  if (m.includes('a reason is required to downgrade or cancel your plan')) {
    return { status: 400, error: 'A reason is required to downgrade or cancel your plan.' }
  }
  if (m.includes('keep_set_exceeds_target_cap')) {
    return { status: 422, error: 'You selected more items than your target plan allows. Please choose fewer.' }
  }
  if (m.includes('keep_set_entity_invalid')) {
    return { status: 422, error: 'One of the selected items is no longer eligible. Please refresh and try again.' }
  }
  if (m.includes('no pending downgrade to select a keep-set for')) {
    return { status: 409, error: 'There is no pending downgrade to configure.' }
  }
  if (m.includes('no frozen downgrade to resolve')) {
    return { status: 409, error: 'There is nothing to resolve — your account is not currently frozen.' }
  }
  if (m.includes('publication_frozen_pending_keep_set')) {
    return { status: 409, error: 'Resolve your downgrade selection before publishing or reactivating anything.' }
  }
  if (m.includes('merchant id is required') || m.includes('admin id is required') || m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

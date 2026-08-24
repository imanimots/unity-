/**
 * Maps known RAISE EXCEPTION messages from the marketplace request/offer
 * RPCs (supabase/migrations/20260826000003-05*.sql) to a user-safe
 * message + HTTP status. Same substring .includes() convention as
 * src/lib/barter/rpc-errors.ts -- never regex, never exact equality.
 */
export function mapMarketplaceRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) return { status: 401, error: 'You must be signed in.' }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('verification_required:counterparty')) {
    return { status: 403, error: 'This listing is not currently available for a new transaction.' }
  }
  if (m.includes('verification_required:self')) return { status: 403, error: 'You need to complete verification before doing this.' }
  if (m.includes('verification_required')) return { status: 403, error: 'You need to complete verification before doing this.' }
  if (m.includes('account_restricted:self') || m.includes('account_suspended:self')) {
    return { status: 403, error: 'Your account cannot do this right now. Contact support if you believe this is a mistake.' }
  }
  if (m.includes('account_restricted:counterparty') || m.includes('account_suspended:counterparty')) {
    return { status: 403, error: 'This listing is not currently available for a new transaction.' }
  }
  if (m.includes('invalid transaction type')) return { status: 422, error: 'Invalid transaction type.' }
  if (m.includes('a title is required')) return { status: 422, error: 'A title is required.' }
  if (m.includes('request not found')) return { status: 404, error: 'Request not found.' }
  if (m.includes('not the owner of this request')) return { status: 403, error: 'You are not the owner of this request.' }
  if (m.includes('only a draft request can be edited')) return { status: 409, error: 'Only a draft request can be edited.' }
  if (m.includes('cannot be published from here')) return { status: 409, error: 'This request cannot be published from its current status.' }
  if (m.includes('cannot be closed from here')) return { status: 409, error: 'This request cannot be closed from its current status.' }
  if (m.includes('cannot be archived from here')) return { status: 409, error: 'This request cannot be archived from its current status.' }
  if (m.includes('cannot be reposted from here')) return { status: 409, error: 'This request cannot be reposted from its current status.' }
  if (m.includes('active_publication_limit_reached') || m.includes('active_listing_limit_reached')) return { status: 422, error: 'Your current plan has reached its active publication limit. Upgrade your plan to publish more.' }
  if (m.includes('publication_frozen_pending_keep_set')) return { status: 409, error: 'Resolve your downgrade selection before publishing or reactivating anything.' }
  if (m.includes('cannot be deactivated')) return { status: 409, error: 'This request cannot be deactivated from its current status.' }
  if (m.includes('only a deactivated request can be reactivated from here')) return { status: 409, error: 'Only a deactivated request can be reactivated.' }
  if (m.includes('invalid actor role')) return { status: 500, error: 'Could not process your request — please try again' }
  if (m.includes('invalid offer type')) return { status: 422, error: 'Invalid offer type.' }
  if (m.includes('is not accepting offers')) return { status: 409, error: 'This request is no longer accepting offers.' }
  if (m.includes('cannot respond to your own request')) return { status: 403, error: 'You cannot respond to your own request.' }
  if (m.includes('a listing must be linked for this offer type')) return { status: 422, error: 'A listing must be linked for this offer type.' }
  if (m.includes('linked listing not found or not owned by you')) return { status: 404, error: 'That listing was not found or is not owned by you.' }
  if (m.includes('linked listing is not active')) return { status: 422, error: 'That listing is not currently active.' }
  if (m.includes('linked listing is no longer available')) return { status: 409, error: 'That listing is no longer available.' }
  if (m.includes('offer not found')) return { status: 404, error: 'Offer not found.' }
  if (m.includes('not the owner of this offer')) return { status: 403, error: 'You are not the owner of this offer.' }
  if (m.includes('cannot be withdrawn from here')) return { status: 409, error: 'This offer cannot be withdrawn from its current status.' }
  if (m.includes('cannot be declined from here')) return { status: 409, error: 'This offer cannot be declined from its current status.' }
  if (m.includes('is no longer accept-able')) return { status: 409, error: 'This request is no longer accept-able.' }
  if (m.includes('can no longer be accepted')) return { status: 409, error: 'This offer can no longer be accepted.' }
  if (m.includes('a message-only response cannot be accepted')) return { status: 422, error: 'A message-only response cannot be accepted as a transaction.' }
  if (m.includes('not authorized')) return { status: 500, error: 'Could not process your request — please try again' }

  return { status: 500, error: 'Could not process your request — please try again' }
}

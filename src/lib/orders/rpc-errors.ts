/**
 * Maps known RAISE EXCEPTION messages from the order RPCs
 * (supabase/migrations/20260812000002_order_payments_widening.sql /
 * 20260812000004_order_rpcs.sql) to a user-safe message + HTTP status.
 * Same convention as src/lib/bookings/rpc-errors.ts -- substring
 * .includes() matching, never forward a raw Postgres error to the client.
 */
export function mapOrderRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('quantity must be at least 1')) {
    return { status: 400, error: 'Quantity must be at least 1.' }
  }
  if (m.includes('listing not found or not available for purchase')) {
    return { status: 404, error: 'This listing is not available for purchase.' }
  }
  if (m.includes('you cannot buy your own listing')) {
    return { status: 403, error: 'You cannot buy your own listing.' }
  }
  if (m.includes('verification_required:counterparty')) {
    return { status: 403, error: 'This listing is not currently available for a new transaction.' }
  }
  if (m.includes('verification_required:self')) {
    return { status: 403, error: 'You need to complete verification before doing this.' }
  }
  if (m.includes('account_restricted:self') || m.includes('account_suspended:self')) {
    return { status: 403, error: 'Your account cannot do this right now. Contact support if you believe this is a mistake.' }
  }
  if (m.includes('account_restricted:counterparty') || m.includes('account_suspended:counterparty')) {
    return { status: 403, error: 'This listing is not currently available for a new transaction.' }
  }
  if (m.includes('currently committed to a barter agreement')) {
    return { status: 409, error: 'This listing is currently committed to a barter agreement and cannot be purchased.' }
  }
  if (m.includes('insufficient stock available')) {
    return { status: 409, error: 'Not enough stock is available for the requested quantity.' }
  }
  if (m.includes('this order is not awaiting payment')) {
    return { status: 409, error: 'This order is not awaiting payment.' }
  }
  if (m.includes('you are not the seller')) {
    return { status: 404, error: 'Order not found.' }
  }
  if (m.includes('this order is not ready to be marked as shipped')) {
    return { status: 409, error: 'This order is not ready to be marked as shipped.' }
  }
  if (m.includes('you are not the buyer')) {
    return { status: 404, error: 'Order not found.' }
  }
  if (m.includes('this order has not been marked as shipped yet')) {
    return { status: 409, error: 'This order has not been marked as shipped yet.' }
  }
  if (m.includes('you are not a party to it')) {
    return { status: 404, error: 'Order not found.' }
  }
  if (m.includes('already shipped and can only be cancelled')) {
    return { status: 409, error: 'This order has already shipped and can no longer be self-cancelled.' }
  }
  if (m.includes('this order has already been cancelled')) {
    return { status: 409, error: 'This order has already been cancelled.' }
  }
  if (m.includes('currently disputed and can only be cancelled')) {
    return { status: 409, error: 'This order is currently disputed and can no longer be self-cancelled.' }
  }
  if (m.includes('order not found')) {
    return { status: 404, error: 'Order not found.' }
  }
  if (m.includes('invalid amount')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

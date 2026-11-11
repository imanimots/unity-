/**
 * Maps known RAISE EXCEPTION messages from the dispute RPCs
 * (supabase/migrations/20260814000006_dispute_rpcs.sql) to a user-safe
 * message + HTTP status. Same convention as src/lib/orders/rpc-errors.ts
 * -- substring .includes() matching, never forward a raw Postgres error
 * to the client.
 */
export function mapDisputeRpcError(message: string | undefined): { status: number; error: string } {
  const m = message ?? ''

  if (m.includes('not authenticated') || m.includes('you must be signed in')) {
    return { status: 401, error: 'You must be signed in.' }
  }
  if (m.includes('idempotency key already used with a different request')) {
    return { status: 409, error: 'This request was already submitted with different data. Please refresh and try again.' }
  }
  if (m.includes('exactly one of booking_id, order_id, or barter_agreement_id')) {
    return { status: 400, error: 'A dispute must reference exactly one booking, order, or barter trade.' }
  }
  if (m.includes('title is required') || m.includes('description is required') || m.includes('requested resolution is required')) {
    return { status: 400, error: 'Please fill in every required field.' }
  }
  if (m.includes('booking not found')) {
    return { status: 404, error: 'Booking not found.' }
  }
  if (m.includes('order not found')) {
    return { status: 404, error: 'Order not found.' }
  }
  if (m.includes('barter agreement not found')) {
    return { status: 404, error: 'Trade not found.' }
  }
  if (m.includes('raiser is not a party to this')) {
    return { status: 403, error: 'You are not a party to this transaction.' }
  }
  if (m.includes('a dispute is already open for this')) {
    return { status: 409, error: 'A dispute is already open for this transaction.' }
  }
  if (m.includes('dispute not found')) {
    return { status: 404, error: 'Dispute not found.' }
  }
  if (m.includes('assignee must be an admin')) {
    return { status: 400, error: 'The assignee must be an admin.' }
  }
  if (m.includes('this dispute is no longer active')) {
    return { status: 409, error: 'This dispute is no longer active.' }
  }
  if (m.includes('this dispute is not ready to move into review')) {
    return { status: 409, error: 'This dispute is not ready to move into review.' }
  }
  if (m.includes('evidence can only be requested while a dispute is open or under review')) {
    return { status: 409, error: 'Evidence can only be requested while a dispute is open or under review.' }
  }
  if (m.includes('invalid outcome')) {
    return { status: 400, error: 'Invalid resolution outcome.' }
  }
  if (m.includes('a dispute can only be resolved while under review')) {
    return { status: 409, error: 'A dispute can only be resolved while it is under review.' }
  }
  if (m.includes('a dispute can only be closed after it has been resolved')) {
    return { status: 409, error: 'A dispute can only be closed after it has been resolved.' }
  }
  // Raised by bookings_check_availability_conflict()
  // (20260914101000_enforce_booking_listing_availability_integrity.sql)
  // when restoring a booking's pre-dispute status would put it back into
  // a date range the merchant has since marked unavailable elsewhere.
  // Same canonical message/status as the booking-side conflict
  // (src/lib/bookings/rpc-errors.ts already recognizes it) -- kept
  // consistent here rather than falling through to a generic 500.
  if (m.includes('this listing is no longer available for the requested dates')) {
    return { status: 409, error: 'The requested dates are no longer available for this listing.' }
  }
  // E28: record_dispute_financial_disposition / complete_dispute_financial_disposition.
  if (m.includes('invalid disposition type')) {
    return { status: 400, error: 'Invalid financial disposition type.' }
  }
  if (m.includes('a reason is required')) {
    return { status: 400, error: 'A reason is required.' }
  }
  if (m.includes('must not carry an amount') || m.includes('a positive amount is required for this disposition type')) {
    return { status: 400, error: 'Please provide the correct amount for this disposition type.' }
  }
  if (m.includes('financial disposition is only supported for booking disputes')) {
    return { status: 400, error: 'A financial disposition can only be recorded for a booking dispute.' }
  }
  if (m.includes('a dispute must be resolved before a financial disposition can be recorded')) {
    return { status: 409, error: 'This dispute must be resolved before a financial disposition can be recorded.' }
  }
  if (m.includes('a financial disposition has already been recorded for this dispute')) {
    return { status: 409, error: 'A financial disposition has already been recorded for this dispute.' }
  }
  if (m.includes('no rental charge payment exists for this booking to refund')) {
    return { status: 409, error: 'No refundable payment exists for this booking.' }
  }
  if (m.includes('the booking payment is not in a refundable status')) {
    return { status: 409, error: 'This booking payment is not in a refundable status.' }
  }
  if (m.includes('refund amount exceeds the amount available to refund')) {
    return { status: 400, error: 'The refund amount exceeds the amount available to refund.' }
  }
  if (m.includes('no financial disposition exists for this dispute')) {
    return { status: 404, error: 'No financial disposition exists for this dispute.' }
  }
  if (m.includes('this financial disposition is not pending completion')) {
    return { status: 409, error: 'This financial disposition is not pending completion.' }
  }
  // E28-R1: resolve_booking_dispute / resolve_dispute's new domain guard.
  if (m.includes('booking disputes must be resolved via resolve_booking_dispute')) {
    return { status: 400, error: 'Booking disputes must be resolved with a financial disposition.' }
  }
  if (m.includes('resolve_booking_dispute is only for booking disputes')) {
    return { status: 400, error: 'This action is only available for booking disputes.' }
  }
  if (m.includes('this booking has escrow activity and cannot be refunded through this path')) {
    return { status: 409, error: 'This booking has escrow activity that must be reconciled separately before a refund can be recorded.' }
  }
  // E29: complete_dispute_financial_disposition's type-aware hardening,
  // and the two new refund-provider-result RPCs.
  if (m.includes('the linked refund has not been authoritatively completed by the payment provider yet')) {
    return { status: 409, error: 'This refund has not been completed by the payment provider yet.' }
  }
  if (m.includes('completion notes are required for a manual financial settlement')) {
    return { status: 400, error: 'Completion notes are required for a manual settlement.' }
  }
  if (m.includes('refund not found')) {
    return { status: 404, error: 'Refund not found.' }
  }
  if (m.includes('refund is not pending a provider attempt')) {
    return { status: 409, error: 'This refund is not pending a provider attempt.' }
  }
  if (m.includes('refund is not awaiting a provider result')) {
    return { status: 409, error: 'This refund is not awaiting a provider result.' }
  }
  if (m.includes('invalid provider status')) {
    return { status: 400, error: 'Invalid refund provider status.' }
  }
  if (m.includes('not authorized')) {
    return { status: 500, error: 'Could not process your request — please try again' }
  }

  return { status: 500, error: 'Could not process your request — please try again' }
}

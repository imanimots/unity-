import { describe, it, expect } from 'vitest'
import { mapDisputeRpcError } from '../rpc-errors'

describe('mapDisputeRpcError', () => {
  it.each([
    ['not authenticated', 401],
    ['idempotency key already used with a different request', 409],
    ['exactly one of booking_id, order_id, or barter_agreement_id is required', 400],
    ['title is required', 400],
    ['description is required', 400],
    ['requested resolution is required', 400],
    ['booking not found', 404],
    ['order not found', 404],
    ['barter agreement not found', 404],
    ['raiser is not a party to this booking', 403],
    ['a dispute is already open for this booking', 409],
    ['dispute not found', 404],
    ['assignee must be an admin', 400],
    ['this dispute is no longer active', 409],
    ['this dispute is not ready to move into review', 409],
    ['evidence can only be requested while a dispute is open or under review', 409],
    ['invalid outcome', 400],
    ['a dispute can only be resolved while under review', 409],
    ['a dispute can only be closed after it has been resolved', 409],
    ['this listing is no longer available for the requested dates', 409],
    ['invalid disposition type', 400],
    ['a reason is required', 400],
    ['no_financial_adjustment must not carry an amount', 400],
    ['a positive amount is required for this disposition type', 400],
    ['financial disposition is only supported for booking disputes', 400],
    ['a dispute must be resolved before a financial disposition can be recorded', 409],
    ['a financial disposition has already been recorded for this dispute', 409],
    ['no rental charge payment exists for this booking to refund', 409],
    ['the booking payment is not in a refundable status', 409],
    ['refund amount exceeds the amount available to refund', 400],
    ['no financial disposition exists for this dispute', 404],
    ['this financial disposition is not pending completion', 409],
    ['booking disputes must be resolved via resolve_booking_dispute', 400],
    ['resolve_booking_dispute is only for booking disputes', 400],
    ['this booking has escrow activity and cannot be refunded through this path -- reconcile escrow custody separately first', 409],
    ['the linked refund has not been authoritatively completed by the payment provider yet', 409],
    ['completion notes are required for a manual financial settlement', 400],
    ['refund not found', 404],
    ['refund is not pending a provider attempt', 409],
    ['refund is not awaiting a provider result', 409],
    ['invalid provider status', 400],
    ['not authorized', 500],
  ])('maps %j to status %i', (message, status) => {
    expect(mapDisputeRpcError(message).status).toBe(status)
  })

  it('maps the booking-availability-conflict trigger message to the same conflict wording used on the booking side', () => {
    expect(mapDisputeRpcError('this listing is no longer available for the requested dates')).toEqual({
      status: 409,
      error: 'The requested dates are no longer available for this listing.',
    })
  })

  it('falls back to a generic 500 for an unrecognized message', () => {
    expect(mapDisputeRpcError('something totally unexpected')).toEqual({ status: 500, error: 'Could not process your request — please try again' })
  })

  it('handles an undefined message', () => {
    expect(mapDisputeRpcError(undefined)).toEqual({ status: 500, error: 'Could not process your request — please try again' })
  })
})

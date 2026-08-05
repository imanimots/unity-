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
    ['not authorized', 500],
  ])('maps %j to status %i', (message, status) => {
    expect(mapDisputeRpcError(message).status).toBe(status)
  })

  it('falls back to a generic 500 for an unrecognized message', () => {
    expect(mapDisputeRpcError('something totally unexpected')).toEqual({ status: 500, error: 'Could not process your request — please try again' })
  })

  it('handles an undefined message', () => {
    expect(mapDisputeRpcError(undefined)).toEqual({ status: 500, error: 'Could not process your request — please try again' })
  })
})

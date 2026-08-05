import { describe, it, expect } from 'vitest'
import { mapBarterRpcError } from '../rpc-errors'

describe('mapBarterRpcError', () => {
  it.each([
    ['not authenticated', 401],
    ['idempotency key already used with a different request', 409],
    ['invalid expiry window', 500],
    ['at least one listing must be offered from the requested side', 422],
    ['at least one listing must be offered from the offered side', 422],
    ['the same listing cannot be offered more than once in a single offer', 422],
    ['one or more offered listings could not be found', 404],
    ['a listing offered on the requested side does not belong to that party', 403],
    ['one or more offered listings are not yet active', 422],
    ['one or more offered listings are currently committed to another barter agreement', 409],
    ['this listing is not available for barter', 404],
    ['you cannot propose a trade on your own listing', 403],
    ['barter agreement not found or you are not a party to it', 404],
    ['this barter agreement is currently suspended by an administrator', 403],
    ['this offer can no longer be countered', 409],
    ['this offer can no longer be accepted', 409],
    ['this offer can no longer be rejected', 409],
    ['it is not your turn to respond to this offer', 403],
    ['cannot cancel a disputed agreement', 409],
    ['this agreement cannot be cancelled in its current status', 409],
    ['listing not found', 404],
    ['not authorized', 500],
    ['this agreement is currently disputed and cannot progress until it is resolved', 409],
    ['this agreement is currently disputed and cannot be completed until it is resolved', 409],
    ['this agreement is not yet financially ready to proceed', 409],
    ['this delivery method does not use an in-transit step', 409],
    ['this delivery method requires marking the item in transit first', 409],
    ["this transition is not allowed from the agreement's current status", 409],
    ['this agreement is not yet awaiting completion confirmation', 409],
    ['invalid payment type for a barter payment intent', 500],
  ])('maps %j to status %i', (message, status) => {
    expect(mapBarterRpcError(message).status).toBe(status)
  })

  it('falls back to a generic 500 for an unrecognized message', () => {
    const result = mapBarterRpcError('something totally unexpected')
    expect(result).toEqual({ status: 500, error: 'Could not process your request — please try again' })
  })

  it('never leaks the raw message text back as the user-facing error', () => {
    const raw = 'internal detail: constraint barter_offers_deposit_chk violated'
    const result = mapBarterRpcError(raw)
    expect(result.error).not.toContain('constraint')
  })

  it('handles an undefined message', () => {
    expect(mapBarterRpcError(undefined)).toEqual({ status: 500, error: 'Could not process your request — please try again' })
  })
})

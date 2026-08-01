import { describe, it, expect } from 'vitest'
import { mapBookingRpcError } from '../rpc-errors'

describe('mapBookingRpcError', () => {
  it('maps a reused idempotency key with a different payload to 409', () => {
    const result = mapBookingRpcError('idempotency key already used with a different request')
    expect(result.status).toBe(409)
  })

  it('maps booking your own listing to 403', () => {
    expect(mapBookingRpcError('you cannot book your own listing').status).toBe(403)
  })

  it('maps a merchant-blocked date range to 409', () => {
    expect(mapBookingRpcError('requested dates fall within a period the merchant has marked unavailable').status).toBe(409)
  })

  it('maps a post-acceptance conflict to 409', () => {
    expect(mapBookingRpcError('this listing is no longer available for the requested dates').status).toBe(409)
  })

  it('maps an expired request acceptance attempt to 409', () => {
    expect(mapBookingRpcError('this request has expired and can no longer be accepted').status).toBe(409)
  })

  it('maps a too-early start attempt to 422', () => {
    expect(mapBookingRpcError('too early to start this rental').status).toBe(422)
  })

  it('maps the initiator confirming their own return to 403', () => {
    expect(mapBookingRpcError('the other party must confirm the return, not the party who initiated it').status).toBe(403)
  })

  it('maps an active-booking self-cancel attempt to 403', () => {
    expect(mapBookingRpcError('active bookings can only be cancelled through an administrative process').status).toBe(403)
  })

  it('maps a passed cancellation notice window to 422', () => {
    expect(mapBookingRpcError('the cancellation notice period for this booking has passed').status).toBe(422)
  })

  it('maps unauthenticated to 401', () => {
    expect(mapBookingRpcError('not authenticated').status).toBe(401)
  })

  it('falls back to a generic 500 for an unrecognized message and never leaks raw SQL', () => {
    const result = mapBookingRpcError('duplicate key value violates unique constraint "some_internal_constraint"')
    expect(result.status).toBe(500)
    expect(result.error).not.toContain('constraint')
  })

  it('falls back safely when the message is undefined', () => {
    expect(mapBookingRpcError(undefined).status).toBe(500)
  })
})

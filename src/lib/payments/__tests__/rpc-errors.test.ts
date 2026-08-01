import { describe, it, expect } from 'vitest'
import { mapPaymentRpcError } from '../rpc-errors'

describe('mapPaymentRpcError', () => {
  it('maps a reused idempotency key with a different payload to 409', () => {
    expect(mapPaymentRpcError('idempotency key already used with a different request').status).toBe(409)
  })

  it('maps an invalid transition to 409', () => {
    expect(mapPaymentRpcError('invalid payment status transition from captured to pending').status).toBe(409)
  })

  it('maps a refund-exceeds-available error to 422', () => {
    expect(mapPaymentRpcError('refund amount exceeds the amount available to refund').status).toBe(422)
  })

  it('maps a non-refundable-status error to 409', () => {
    expect(mapPaymentRpcError('payment is not in a refundable status').status).toBe(409)
  })

  it('maps payment/booking not found to 404', () => {
    expect(mapPaymentRpcError('payment not found').status).toBe(404)
    expect(mapPaymentRpcError('booking not found').status).toBe(404)
  })

  it('falls back to a generic 500 and never leaks raw SQL', () => {
    const result = mapPaymentRpcError('duplicate key value violates unique constraint "payments_booking_type_unique"')
    expect(result.status).toBe(500)
    expect(result.error).not.toContain('constraint')
  })

  it('falls back safely when the message is undefined', () => {
    expect(mapPaymentRpcError(undefined).status).toBe(500)
  })
})

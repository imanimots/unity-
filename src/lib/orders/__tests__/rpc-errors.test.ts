import { describe, it, expect } from 'vitest'
import { mapOrderRpcError } from '../rpc-errors'

describe('mapOrderRpcError', () => {
  it.each([
    ['not authenticated', 401],
    ['idempotency key already used with a different request', 409],
    ['quantity must be at least 1', 400],
    ['listing not found or not available for purchase', 404],
    ['you cannot buy your own listing', 403],
    ['this listing is currently committed to a barter agreement', 409],
    ['insufficient stock available for the requested quantity', 409],
    ['this order is not awaiting payment', 409],
    ['order not found or you are not the seller', 404],
    ['this order is not ready to be marked as shipped', 409],
    ['order not found or you are not the buyer', 404],
    ['this order has not been marked as shipped yet', 409],
    ['order not found or you are not a party to it', 404],
    ['this order has already shipped and can only be cancelled through an administrative process', 409],
    ['this order has already been cancelled', 409],
    ['this order is currently disputed and can only be cancelled through an administrative process', 409],
    ['order not found', 404],
    ['invalid amount', 500],
    ['not authorized', 500],
  ])('maps %j to status %i', (message, status) => {
    expect(mapOrderRpcError(message).status).toBe(status)
  })

  it('falls back to a generic 500 for an unrecognized message', () => {
    expect(mapOrderRpcError('something totally unexpected')).toEqual({ status: 500, error: 'Could not process your request — please try again' })
  })

  it('handles an undefined message', () => {
    expect(mapOrderRpcError(undefined)).toEqual({ status: 500, error: 'Could not process your request — please try again' })
  })
})

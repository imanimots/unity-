import { describe, it, expect } from 'vitest'
import { mapProfileRpcError } from '../rpc-errors'

describe('mapProfileRpcError', () => {
  it.each([
    ['not authenticated', 401],
    ['idempotency key already used with a different request', 409],
    ['you cannot report your own profile', 403],
    ['invalid report reason', 422],
    ['reported profile not found', 404],
    ['a reported profile is required', 400],
    ['not authorized', 500],
  ])('maps %j to status %i', (message, status) => {
    expect(mapProfileRpcError(message).status).toBe(status)
  })

  it('falls back to a generic 500 for an unrecognized message', () => {
    expect(mapProfileRpcError('something totally unexpected')).toEqual({ status: 500, error: 'Could not process your request — please try again' })
  })

  it('handles an undefined message', () => {
    expect(mapProfileRpcError(undefined)).toEqual({ status: 500, error: 'Could not process your request — please try again' })
  })
})

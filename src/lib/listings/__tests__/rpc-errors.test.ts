import { describe, it, expect } from 'vitest'
import { mapListingRpcError } from '../rpc-errors'

describe('mapListingRpcError', () => {
  it('maps a reused idempotency key with a different payload to 409', () => {
    const result = mapListingRpcError('idempotency key already used with a different request')
    expect(result.status).toBe(409)
    expect(result.error).not.toContain('idempotency') // user-safe wording, not the raw term
  })

  it('maps an invalid category to 400', () => {
    const result = mapListingRpcError('invalid or inactive category: made_up_category')
    expect(result.status).toBe(400)
  })

  it('maps a forged media URL (direct-RPC bypass attempt) to 400', () => {
    const result = mapListingRpcError('ownership proof file does not belong to the caller')
    expect(result.status).toBe(400)
  })

  it('maps overlapping blocked date ranges to 400', () => {
    const result = mapListingRpcError('blocked date ranges must not overlap')
    expect(result.status).toBe(400)
  })

  it('maps a no-longer-draft listing to 409 on save', () => {
    const result = mapListingRpcError('listing not found, not owned by caller, or no longer a draft')
    expect(result.status).toBe(409)
  })

  it('maps a no-longer-draft listing to 409 on submit', () => {
    const result = mapListingRpcError('listing not found, not owned by caller, or not in draft status')
    expect(result.status).toBe(409)
  })

  it('maps missing declarations to 422', () => {
    const result = mapListingRpcError('all required declarations must be accepted before submission')
    expect(result.status).toBe(422)
  })

  it('maps unauthenticated to 401', () => {
    const result = mapListingRpcError('not authenticated')
    expect(result.status).toBe(401)
  })

  it('falls back to a generic 500 for an unrecognized message', () => {
    const result = mapListingRpcError('duplicate key value violates unique constraint "some_internal_constraint"')
    expect(result.status).toBe(500)
    expect(result.error).not.toContain('constraint') // never leak raw SQL error text
  })

  it('falls back safely when the message is undefined', () => {
    const result = mapListingRpcError(undefined)
    expect(result.status).toBe(500)
  })
})

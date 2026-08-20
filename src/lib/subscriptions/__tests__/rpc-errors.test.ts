import { describe, it, expect } from 'vitest'
import { mapSubscriptionRpcError } from '../rpc-errors'

describe('mapSubscriptionRpcError (category: Security)', () => {
  it('1. never forwards the raw Postgres message to the client', () => {
    const mapped = mapSubscriptionRpcError('not authorized')
    expect(mapped.error).not.toContain('not authorized')
    expect(mapped.status).toBe(500)
  })

  it('2. maps every known RAISE EXCEPTION message to a safe status/message', () => {
    expect(mapSubscriptionRpcError('unknown plan: enterprise').status).toBe(400)
    expect(mapSubscriptionRpcError('plan pro is not currently available').status).toBe(400)
    expect(mapSubscriptionRpcError('merchant is already on plan pro -- use cancel_pending_merchant_plan_change to undo a scheduled change instead').status).toBe(409)
    expect(mapSubscriptionRpcError('a successful billing reference is required to upgrade').status).toBe(402)
    expect(mapSubscriptionRpcError('no pending plan change to cancel').status).toBe(404)
    expect(mapSubscriptionRpcError('a reason is required for an administrative correction').status).toBe(400)
    expect(mapSubscriptionRpcError('active_publication_limit_reached: the starter plan allows up to 5 active published entities').status).toBe(422)
    expect(mapSubscriptionRpcError('idempotency key already used with a different request').status).toBe(409)
    expect(mapSubscriptionRpcError('not authenticated').status).toBe(401)
  })

  it('3. an unrecognized message falls back to a generic 500, never a raw passthrough', () => {
    const mapped = mapSubscriptionRpcError('some brand new postgres error nobody mapped yet')
    expect(mapped.status).toBe(500)
    expect(mapped.error).toBe('Could not process your request — please try again')
  })

  it('4. handles an undefined message without throwing', () => {
    expect(() => mapSubscriptionRpcError(undefined)).not.toThrow()
    expect(mapSubscriptionRpcError(undefined).status).toBe(500)
  })
})

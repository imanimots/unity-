import { describe, it, expect } from 'vitest'
import { mapCommissionRpcError } from '../rpc-errors'

describe('mapCommissionRpcError (category: Security)', () => {
  it('1. never forwards the raw Postgres message to the client', () => {
    const mapped = mapCommissionRpcError('not authorized')
    expect(mapped.error).not.toContain('not authorized')
    expect(mapped.status).toBe(500)
  })

  it('2. maps every known RAISE EXCEPTION message to a safe status/message', () => {
    expect(mapCommissionRpcError('commission not found').status).toBe(404)
    expect(mapCommissionRpcError('commission is in status pending and cannot transition to voided from here').status).toBe(409)
    expect(mapCommissionRpcError('a reason is required to void a commission').status).toBe(400)
    expect(mapCommissionRpcError('idempotency key already used with a different request').status).toBe(409)
    expect(mapCommissionRpcError('not authenticated').status).toBe(401)
  })

  it('3. an unrecognized message falls back to a generic 500, never a raw passthrough', () => {
    const mapped = mapCommissionRpcError('some brand new postgres error nobody mapped yet')
    expect(mapped.status).toBe(500)
    expect(mapped.error).toBe('Could not process your request — please try again')
  })

  it('4. handles an undefined message without throwing', () => {
    expect(() => mapCommissionRpcError(undefined)).not.toThrow()
    expect(mapCommissionRpcError(undefined).status).toBe(500)
  })
})

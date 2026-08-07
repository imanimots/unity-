import { describe, it, expect } from 'vitest'
import { mapPayoutRpcError } from '../rpc-errors'

describe('mapPayoutRpcError (category: Security, Financial Integrity)', () => {
  it('1. maps an idempotency conflict to 409', () => {
    const result = mapPayoutRpcError('idempotency key already used with a different request')
    expect(result.status).toBe(409)
  })

  it('2. maps an ineligible-to-process message to 422, not a generic 500', () => {
    const result = mapPayoutRpcError('payout is not currently eligible to process: compliance_review')
    expect(result.status).toBe(422)
  })

  it('3. maps a stale-state transition message to 409', () => {
    const result = mapPayoutRpcError('payout is in status paid and cannot be marked failed from here')
    expect(result.status).toBe(409)
  })

  it('4. never leaks the raw Postgres message into the returned error string', () => {
    const raw = 'payout is in status processing and cannot start processing from here'
    const result = mapPayoutRpcError(raw)
    expect(result.error).not.toBe(raw)
  })

  it('5. maps an unrecognized message to a generic 500 fallback, never throwing', () => {
    const result = mapPayoutRpcError('some completely unexpected postgres internals message')
    expect(result.status).toBe(500)
    expect(result.error).toBeTruthy()
  })

  it('6. handles an undefined message safely', () => {
    expect(() => mapPayoutRpcError(undefined)).not.toThrow()
  })
})

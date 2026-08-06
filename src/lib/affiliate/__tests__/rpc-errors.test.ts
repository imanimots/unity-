import { describe, it, expect } from 'vitest'
import { mapAffiliateRpcError } from '../rpc-errors'

describe('mapAffiliateRpcError (category: Security)', () => {
  it('1. maps self-referral to a 403, never a raw Postgres message', () => {
    const mapped = mapAffiliateRpcError('self-referral is not permitted')
    expect(mapped.status).toBe(403)
    expect(mapped.error).not.toContain('exception')
  })
  it('2. maps a stale-state transition to a 409', () => {
    const mapped = mapAffiliateRpcError('commission is in status paid and cannot transition to voided from here')
    expect(mapped.status).toBe(409)
  })
  it('3. maps a missing reason to a 400', () => {
    const mapped = mapAffiliateRpcError('a reason is required to void a commission')
    expect(mapped.status).toBe(400)
  })
  it('4. maps idempotency conflict to a 409', () => {
    const mapped = mapAffiliateRpcError('idempotency key already used with a different request')
    expect(mapped.status).toBe(409)
  })
  it('5. an unrecognized message falls back to a generic 500, never echoes raw internals', () => {
    const mapped = mapAffiliateRpcError('some unexpected internal postgres detail')
    expect(mapped.status).toBe(500)
    expect(mapped.error).toBe('Could not process your request — please try again')
  })
})

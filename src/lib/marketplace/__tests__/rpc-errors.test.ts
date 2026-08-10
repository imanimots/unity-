import { describe, it, expect } from 'vitest'
import { mapMarketplaceRpcError } from '../rpc-errors'

// Narrow, focused coverage for the transaction-time merchant
// KYC-reverification hardening pass -- not a full backfill of every
// pre-existing case in mapMarketplaceRpcError (none had test coverage
// before this pass; broadening that is out of scope here).
describe('mapMarketplaceRpcError -- verification_required', () => {
  it('maps a self KYC failure to a 403 telling the caller to verify', () => {
    const result = mapMarketplaceRpcError('verification_required:self')
    expect(result.status).toBe(403)
    expect(result.error).toMatch(/verification/i)
  })

  it('maps a counterparty (merchant) KYC failure to a 403 that never reveals it is a KYC issue', () => {
    const result = mapMarketplaceRpcError('verification_required:counterparty')
    expect(result.status).toBe(403)
    expect(result.error).not.toMatch(/verif|kyc|aml|document|rejected/i)
  })

  it('the pre-existing generic verification_required message (no role suffix) still maps to 403', () => {
    // Covers publish_marketplace_request()/submit_marketplace_offer()'s
    // own, older "verification_required: ..." wording, untouched by
    // this hardening pass -- must keep matching the generic fallback.
    const result = mapMarketplaceRpcError('verification_required: you must be verified before publishing a request')
    expect(result.status).toBe(403)
  })
})

import { describe, it, expect } from 'vitest'
import { computeOpenAttributionHash, computeQualifyCommissionHash, computeCommissionIdOnlyHash, computeAdjustmentHash } from '../idempotency'

describe('affiliate idempotency hash functions (category: Idempotency)', () => {
  it('1. computeOpenAttributionHash is deterministic for the same inputs', () => {
    expect(computeOpenAttributionHash('listing-1', 'AFC-AAAA')).toBe(computeOpenAttributionHash('listing-1', 'AFC-AAAA'))
  })
  it('2. computeOpenAttributionHash differs for a different listing', () => {
    expect(computeOpenAttributionHash('listing-1', 'AFC-AAAA')).not.toBe(computeOpenAttributionHash('listing-2', 'AFC-AAAA'))
  })
  it('3. computeQualifyCommissionHash differs for a different payment id -- a changed payload must not collide', () => {
    expect(computeQualifyCommissionHash('order-1', 'payment-1')).not.toBe(computeQualifyCommissionHash('order-1', 'payment-2'))
  })
  it('4. computeCommissionIdOnlyHash is deterministic', () => {
    expect(computeCommissionIdOnlyHash('commission-1')).toBe(computeCommissionIdOnlyHash('commission-1'))
  })
  it('5. computeAdjustmentHash changes when the amount changes -- the exact "changed payload, same key -> conflict" case', () => {
    expect(computeAdjustmentHash('commission-1', 10, 'reason')).not.toBe(computeAdjustmentHash('commission-1', 20, 'reason'))
  })
  it('6. computeAdjustmentHash changes when the reason changes', () => {
    expect(computeAdjustmentHash('commission-1', 10, 'reason A')).not.toBe(computeAdjustmentHash('commission-1', 10, 'reason B'))
  })
})

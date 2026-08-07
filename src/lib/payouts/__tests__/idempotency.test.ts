import { describe, it, expect } from 'vitest'
import { computeMarkProcessingHash, computeRetryPayoutHash, computeMarkPaidHash, computeMarkFailedHash } from '../idempotency'

describe('payout idempotency hash formulas (category: Idempotency)', () => {
  it('1. computeMarkProcessingHash is deterministic and null-safe', () => {
    const a = computeMarkProcessingHash('payout-1', 'a note')
    const b = computeMarkProcessingHash('payout-1', 'a note')
    expect(a).toBe(b)
    expect(() => computeMarkProcessingHash('payout-1', null)).not.toThrow()
    expect(() => computeMarkProcessingHash('payout-1', undefined)).not.toThrow()
  })

  it('2. computeMarkProcessingHash changes when the reason changes', () => {
    const a = computeMarkProcessingHash('payout-1', 'reason A')
    const b = computeMarkProcessingHash('payout-1', 'reason B')
    expect(a).not.toBe(b)
  })

  it('3. computeRetryPayoutHash changes when the payout id changes', () => {
    const a = computeRetryPayoutHash('payout-1', 'retry reason')
    const b = computeRetryPayoutHash('payout-2', 'retry reason')
    expect(a).not.toBe(b)
  })

  it('4. computeMarkPaidHash changes when the payout method changes -- a manual vs mock_validation replay must not collide', () => {
    const a = computeMarkPaidHash('payout-1', 'REF-001', 'manual')
    const b = computeMarkPaidHash('payout-1', 'REF-001', 'mock_validation')
    expect(a).not.toBe(b)
  })

  it('5. computeMarkPaidHash changes when the reference changes', () => {
    const a = computeMarkPaidHash('payout-1', 'REF-001', 'manual')
    const b = computeMarkPaidHash('payout-1', 'REF-002', 'manual')
    expect(a).not.toBe(b)
  })

  it('6. computeMarkFailedHash changes when the failure category changes', () => {
    const a = computeMarkFailedHash('payout-1', 'provider_declined', 'same reason')
    const b = computeMarkFailedHash('payout-1', 'compliance_review', 'same reason')
    expect(a).not.toBe(b)
  })

  it('7. all four hash functions produce 32-character hex md5 digests', () => {
    expect(computeMarkProcessingHash('p', 'r')).toMatch(/^[a-f0-9]{32}$/)
    expect(computeRetryPayoutHash('p', 'r')).toMatch(/^[a-f0-9]{32}$/)
    expect(computeMarkPaidHash('p', 'ref', 'manual')).toMatch(/^[a-f0-9]{32}$/)
    expect(computeMarkFailedHash('p', 'other', 'r')).toMatch(/^[a-f0-9]{32}$/)
  })
})

import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { computeQualifyCommissionHash, computeCommissionIdOnlyHash, computeCommissionIdAndReasonHash, computeAdjustmentHash } from '../idempotency'

function md5(input: string): string {
  return createHash('md5').update(input).digest('hex')
}

describe('commission idempotency hashes (category: Idempotency)', () => {
  it('1. computeQualifyCommissionHash mirrors the RPC formula: transactionId|paymentId', () => {
    expect(computeQualifyCommissionHash('order-1', 'payment-1')).toBe(md5('order-1|payment-1'))
  })

  it('2. computeCommissionIdOnlyHash is a bare md5 of the commission id', () => {
    expect(computeCommissionIdOnlyHash('commission-1')).toBe(md5('commission-1'))
  })

  it('3. computeCommissionIdAndReasonHash mirrors commissionId|reason', () => {
    expect(computeCommissionIdAndReasonHash('commission-1', 'fully refunded')).toBe(md5('commission-1|fully refunded'))
  })

  it('4. computeAdjustmentHash mirrors commissionId|amount|reason', () => {
    expect(computeAdjustmentHash('commission-1', -50.5, 'partial refund')).toBe(md5('commission-1|-50.5|partial refund'))
  })

  it('5. different inputs never collide for these fixtures', () => {
    const a = computeQualifyCommissionHash('order-1', 'payment-a')
    const b = computeQualifyCommissionHash('order-1', 'payment-b')
    expect(a).not.toBe(b)
  })
})

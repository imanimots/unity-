import { describe, it, expect } from 'vitest'
import { attributionRequestSchema, adminAffiliateOverrideSchema, adminAffiliateAdjustmentSchema } from '../validation'

describe('attributionRequestSchema (category: Attribution, Security)', () => {
  it('1. accepts a valid listing id + referral code', () => {
    const result = attributionRequestSchema.safeParse({ listing_id: '11111111-1111-4111-8111-111111111111', referral_code: 'AFC-AAAA' })
    expect(result.success).toBe(true)
  })
  it('2. rejects a non-uuid listing id -- the client cannot forge a listing reference through this field', () => {
    const result = attributionRequestSchema.safeParse({ listing_id: 'not-a-uuid', referral_code: 'AFC-AAAA' })
    expect(result.success).toBe(false)
  })
  it('3. rejects an empty referral code', () => {
    const result = attributionRequestSchema.safeParse({ listing_id: '11111111-1111-4111-8111-111111111111', referral_code: '' })
    expect(result.success).toBe(false)
  })
  it("4. has no field for affiliate id, merchant id, or commission rate -- the schema itself makes those unforgeable", () => {
    const shape = attributionRequestSchema.shape
    expect(shape).not.toHaveProperty('affiliate_id')
    expect(shape).not.toHaveProperty('merchant_id')
    expect(shape).not.toHaveProperty('commission_rate')
  })
})

describe('adminAffiliateOverrideSchema (category: Admin)', () => {
  it('5. rejects a missing reason -- every override requires one', () => {
    const result = adminAffiliateOverrideSchema.safeParse({})
    expect(result.success).toBe(false)
  })
  it('6. rejects a blank/whitespace-only reason', () => {
    const result = adminAffiliateOverrideSchema.safeParse({ reason: '   ' })
    expect(result.success).toBe(false)
  })
  it('7. accepts a real reason', () => {
    const result = adminAffiliateOverrideSchema.safeParse({ reason: 'Refund issued, voiding commission' })
    expect(result.success).toBe(true)
  })
})

describe('adminAffiliateAdjustmentSchema (category: Admin)', () => {
  it('8. requires both a finite amount and a reason', () => {
    expect(adminAffiliateAdjustmentSchema.safeParse({ amount: 10, reason: 'correction' }).success).toBe(true)
    expect(adminAffiliateAdjustmentSchema.safeParse({ amount: Infinity, reason: 'correction' }).success).toBe(false)
    expect(adminAffiliateAdjustmentSchema.safeParse({ amount: 10 }).success).toBe(false)
  })
  it('9. accepts a negative amount -- adjustments may be a deduction, not only a credit', () => {
    expect(adminAffiliateAdjustmentSchema.safeParse({ amount: -25, reason: 'overpayment correction' }).success).toBe(true)
  })
})

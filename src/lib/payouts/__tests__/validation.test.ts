import { describe, it, expect } from 'vitest'
import { adminMarkProcessingSchema, adminRetryPayoutSchema, adminMarkPaidSchema, adminMarkFailedSchema } from '../validation'

describe('adminMarkProcessingSchema (category: Admin)', () => {
  it('1. accepts an empty body -- reason is optional for mark-processing', () => {
    expect(adminMarkProcessingSchema.safeParse({}).success).toBe(true)
  })
})

describe('adminRetryPayoutSchema (category: Admin, Financial Integrity)', () => {
  it('2. rejects a missing reason -- retry always requires one', () => {
    expect(adminRetryPayoutSchema.safeParse({}).success).toBe(false)
  })
  it('3. rejects a blank/whitespace-only reason', () => {
    expect(adminRetryPayoutSchema.safeParse({ reason: '   ' }).success).toBe(false)
  })
  it('4. accepts a real reason', () => {
    expect(adminRetryPayoutSchema.safeParse({ reason: 'source payment cleared, retrying' }).success).toBe(true)
  })
})

describe('adminMarkPaidSchema (category: Financial Integrity, Manual Payment Controls)', () => {
  const base = { payoutReference: 'UNI-PAY-0001', payoutMethod: 'manual', confirmManualPayment: true as const }

  it('5. accepts a fully valid manual-paid request', () => {
    expect(adminMarkPaidSchema.safeParse(base).success).toBe(true)
  })
  it('6. rejects confirmManualPayment: false -- the server must reject an absent-or-false confirmation', () => {
    expect(adminMarkPaidSchema.safeParse({ ...base, confirmManualPayment: false }).success).toBe(false)
  })
  it('7. rejects a missing confirmManualPayment entirely', () => {
    const { confirmManualPayment: _omit, ...withoutConfirm } = base
    void _omit
    expect(adminMarkPaidSchema.safeParse(withoutConfirm).success).toBe(false)
  })
  it('8. rejects an empty payout reference', () => {
    expect(adminMarkPaidSchema.safeParse({ ...base, payoutReference: '' }).success).toBe(false)
  })
  it('9. rejects a payout method outside the approved enum -- the browser cannot submit an arbitrary value', () => {
    expect(adminMarkPaidSchema.safeParse({ ...base, payoutMethod: 'bank_transfer' }).success).toBe(false)
    expect(adminMarkPaidSchema.safeParse({ ...base, payoutMethod: 'peach' }).success).toBe(false)
  })
  it('10. accepts mock_validation as the alternate approved method', () => {
    expect(adminMarkPaidSchema.safeParse({ ...base, payoutMethod: 'mock_validation' }).success).toBe(true)
  })
})

describe('adminMarkFailedSchema (category: Failure Categories)', () => {
  it('11. rejects a failure category outside the approved closed vocabulary', () => {
    expect(adminMarkFailedSchema.safeParse({ failureCategory: 'made_up_category', reason: 'x' }).success).toBe(false)
  })
  it('12. accepts every approved failure category', () => {
    const categories = [
      'recipient_details_unavailable', 'recipient_details_invalid', 'provider_unavailable',
      'provider_declined', 'compliance_review', 'account_restricted',
      'source_payment_issue', 'internal_consistency_error', 'other',
    ]
    for (const failureCategory of categories) {
      expect(adminMarkFailedSchema.safeParse({ failureCategory, reason: 'x' }).success, failureCategory).toBe(true)
    }
  })
  it('13. rejects a missing reason', () => {
    expect(adminMarkFailedSchema.safeParse({ failureCategory: 'other' }).success).toBe(false)
  })
})

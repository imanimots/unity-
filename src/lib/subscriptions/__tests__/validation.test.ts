import { describe, it, expect } from 'vitest'
import { requestUpgradeSchema, requestDowngradeSchema, cancelPendingPlanChangeSchema, adminCorrectSubscriptionSchema } from '../validation'

describe('requestUpgradeSchema (category: Validation)', () => {
  it('1. accepts a valid plan id with no mockScenario', () => {
    expect(requestUpgradeSchema.safeParse({ targetPlanId: 'pro' }).success).toBe(true)
  })

  it('2. rejects an unknown plan id -- never trusts an arbitrary client-supplied string', () => {
    expect(requestUpgradeSchema.safeParse({ targetPlanId: 'enterprise' }).success).toBe(false)
  })

  it('3. has no billingReference field at all -- a client cannot forge "already paid"', () => {
    const parsed = requestUpgradeSchema.safeParse({ targetPlanId: 'pro', billingReference: 'forged-ref' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect('billingReference' in parsed.data).toBe(false)
    }
  })

  it('4. accepts a valid mockScenario and rejects an invalid one', () => {
    expect(requestUpgradeSchema.safeParse({ targetPlanId: 'pro', mockScenario: 'declined' }).success).toBe(true)
    expect(requestUpgradeSchema.safeParse({ targetPlanId: 'pro', mockScenario: 'always_succeed' }).success).toBe(false)
  })
})

describe('requestDowngradeSchema (category: Validation)', () => {
  it('5. accepts a valid target plan id', () => {
    expect(requestDowngradeSchema.safeParse({ targetPlanId: 'starter' }).success).toBe(true)
  })

  it('6. rejects a missing targetPlanId', () => {
    expect(requestDowngradeSchema.safeParse({}).success).toBe(false)
  })
})

describe('cancelPendingPlanChangeSchema (category: Validation)', () => {
  it('7. accepts an empty body', () => {
    expect(cancelPendingPlanChangeSchema.safeParse({}).success).toBe(true)
  })
})

describe('adminCorrectSubscriptionSchema (category: Validation)', () => {
  it('8. requires a non-empty reason', () => {
    expect(adminCorrectSubscriptionSchema.safeParse({ newPlanId: 'pro', immediate: true, reason: '' }).success).toBe(false)
    expect(adminCorrectSubscriptionSchema.safeParse({ newPlanId: 'pro', immediate: true, reason: '   ' }).success).toBe(false)
  })

  it('9. accepts a full valid payload', () => {
    expect(adminCorrectSubscriptionSchema.safeParse({ newPlanId: 'elite', immediate: false, reason: 'goodwill correction' }).success).toBe(true)
  })

  it('10. requires immediate to be an explicit boolean, not inferred', () => {
    expect(adminCorrectSubscriptionSchema.safeParse({ newPlanId: 'elite', reason: 'x' }).success).toBe(false)
  })
})

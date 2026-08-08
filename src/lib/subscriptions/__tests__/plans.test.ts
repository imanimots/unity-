import { describe, it, expect } from 'vitest'
import { isMerchantSubscriptionPlanId, MERCHANT_SUBSCRIPTION_PLAN_IDS } from '../plans'

describe('isMerchantSubscriptionPlanId (category: Plans)', () => {
  it('1. accepts every real plan id', () => {
    for (const id of MERCHANT_SUBSCRIPTION_PLAN_IDS) {
      expect(isMerchantSubscriptionPlanId(id)).toBe(true)
    }
  })

  it('2. rejects an unknown string', () => {
    expect(isMerchantSubscriptionPlanId('enterprise')).toBe(false)
    expect(isMerchantSubscriptionPlanId('')).toBe(false)
    expect(isMerchantSubscriptionPlanId('Pro')).toBe(false)
  })

  it('3. the plan id set is exactly starter/pro/elite, in rank order', () => {
    expect(MERCHANT_SUBSCRIPTION_PLAN_IDS).toEqual(['starter', 'pro', 'elite'])
  })
})

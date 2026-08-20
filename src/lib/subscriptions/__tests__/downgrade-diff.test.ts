import { describe, it, expect } from 'vitest'
import { computeDowngradeChangeKeys, encodeDowngradeReason } from '../downgrade-diff'
import type { MerchantSubscriptionPlan } from '@/types'

function plan(overrides: Partial<MerchantSubscriptionPlan>): MerchantSubscriptionPlan {
  return {
    id: 'starter',
    display_name: 'Test',
    monthly_fee_cents: 0,
    currency: 'ZAR',
    sales_commission_bps: 600,
    rental_commission_bps: 1200,
    barter_commission_bps: 0,
    plan_rank: 0,
    active_publication_limit: 5,
    is_active: true,
    commercial_version: 1,
    advertising_discount_bps: 0,
    affiliate_enabled: false,
    analytics_level: 'basic',
    demand_insights_enabled: false,
    listing_assistant_enabled: false,
    analytics_assistant_enabled: false,
    advanced_tools_enabled: false,
    support_level: 'standard',
    business_name_enabled: false,
    elite_badge_enabled: false,
    ...overrides,
  }
}

const STARTER = plan({ id: 'starter' })
const PRO = plan({
  id: 'pro',
  plan_rank: 1,
  active_publication_limit: 20,
  sales_commission_bps: 500,
  rental_commission_bps: 1000,
  advertising_discount_bps: 500,
  affiliate_enabled: true,
  analytics_level: 'full',
  demand_insights_enabled: true,
  listing_assistant_enabled: true,
  advanced_tools_enabled: true,
  support_level: 'priority',
})
const ELITE = plan({
  id: 'elite',
  plan_rank: 2,
  active_publication_limit: null,
  sales_commission_bps: 400,
  rental_commission_bps: 800,
  advertising_discount_bps: 1000,
  affiliate_enabled: true,
  analytics_level: 'full',
  demand_insights_enabled: true,
  listing_assistant_enabled: true,
  analytics_assistant_enabled: true,
  advanced_tools_enabled: true,
  support_level: 'highest',
  business_name_enabled: true,
  elite_badge_enabled: true,
})

describe('computeDowngradeChangeKeys (category: downgrade checklist)', () => {
  it('1. Elite -> Starter surfaces every material change (Section 53)', () => {
    const keys = computeDowngradeChangeKeys(ELITE, STARTER)
    expect(keys).toContain('publicationLimit')
    expect(keys).toContain('saleCommission')
    expect(keys).toContain('rentalCommission')
    expect(keys).toContain('advertisingDiscount')
    expect(keys).toContain('affiliate')
    expect(keys).toContain('analytics')
    expect(keys).toContain('demandInsights')
    expect(keys).toContain('listingAssistant')
    expect(keys).toContain('analyticsAssistant')
    expect(keys).toContain('advancedTools')
    expect(keys).toContain('support')
    expect(keys).toContain('businessName')
    expect(keys).toContain('eliteBadge')
  })

  it('2. Elite -> Pro does NOT surface analytics/advancedTools/affiliate/demandInsights/listingAssistant (Pro already has them, Section 23)', () => {
    const keys = computeDowngradeChangeKeys(ELITE, PRO)
    expect(keys).not.toContain('analytics')
    expect(keys).not.toContain('advancedTools')
    expect(keys).not.toContain('affiliate')
    expect(keys).not.toContain('demandInsights')
    expect(keys).not.toContain('listingAssistant')
  })

  it('3. Elite -> Pro DOES surface analyticsAssistant/businessName/eliteBadge/support/publicationLimit/commission/adDiscount (Pro-exclusive gaps)', () => {
    const keys = computeDowngradeChangeKeys(ELITE, PRO)
    expect(keys).toContain('analyticsAssistant')
    expect(keys).toContain('businessName')
    expect(keys).toContain('eliteBadge')
    expect(keys).toContain('support')
    expect(keys).toContain('publicationLimit')
    expect(keys).toContain('saleCommission')
    expect(keys).toContain('rentalCommission')
    expect(keys).toContain('advertisingDiscount')
  })

  it('4. an upgrade direction (Starter -> Pro) never surfaces a "loss" key -- every check is strictly worse-only', () => {
    expect(computeDowngradeChangeKeys(STARTER, PRO)).toEqual([])
  })

  it('5. same-plan diff is always empty', () => {
    expect(computeDowngradeChangeKeys(PRO, PRO)).toEqual([])
  })

  it('6. unlimited (null) -> a real number always counts as a publicationLimit loss', () => {
    expect(computeDowngradeChangeKeys(ELITE, PRO)).toContain('publicationLimit')
  })
})

describe('encodeDowngradeReason (category: reason storage)', () => {
  it('7. encodes category + text', () => {
    expect(encodeDowngradeReason('too_expensive', 'Cannot justify the cost')).toBe('[too_expensive] Cannot justify the cost')
  })

  it('8. encodes category alone when no text is given', () => {
    expect(encodeDowngradeReason('other', undefined)).toBe('[other]')
  })

  it('9. trims whitespace-only text down to category-only', () => {
    expect(encodeDowngradeReason('other', '   ')).toBe('[other]')
  })
})

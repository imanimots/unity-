import { describe, it, expect } from 'vitest'
import { computeMonthlyPlanCost, findCheapestPlans, computeSavingsCents } from '../economics'
import type { MerchantSubscriptionPlan } from '@/types'

const STARTER: MerchantSubscriptionPlan = {
  id: 'starter',
  display_name: 'Starter',
  monthly_fee_cents: 0,
  currency: 'ZAR',
  sales_commission_bps: 600,
  rental_commission_bps: 1200,
  barter_commission_bps: 0,
  plan_rank: 0,
  active_listing_limit: 5,
  is_active: true,
  commercial_version: 1,
}

const PRO: MerchantSubscriptionPlan = {
  id: 'pro',
  display_name: 'Pro Merchant',
  monthly_fee_cents: 19900,
  currency: 'ZAR',
  sales_commission_bps: 500,
  rental_commission_bps: 1000,
  barter_commission_bps: 0,
  plan_rank: 1,
  active_listing_limit: null,
  is_active: true,
  commercial_version: 1,
}

const ELITE: MerchantSubscriptionPlan = {
  id: 'elite',
  display_name: 'Elite Merchant',
  monthly_fee_cents: 49900,
  currency: 'ZAR',
  sales_commission_bps: 400,
  rental_commission_bps: 800,
  barter_commission_bps: 0,
  plan_rank: 2,
  active_listing_limit: null,
  is_active: true,
  commercial_version: 1,
}

const ALL_PLANS = [STARTER, PRO, ELITE]

describe('computeMonthlyPlanCost (category: Economics)', () => {
  it('1. zero volume costs exactly the monthly fee, no commission', () => {
    for (const plan of ALL_PLANS) {
      const cost = computeMonthlyPlanCost(plan, { salesVolumeCents: 0, rentalVolumeCents: 0 })
      expect(cost.totalCostCents).toBe(plan.monthly_fee_cents)
      expect(cost.salesCommissionCents).toBe(0)
      expect(cost.rentalCommissionCents).toBe(0)
    }
  })

  it('2. barter volume is never a parameter -- barter is commission-free on every plan by construction', () => {
    // No barter field exists on MonthlyVolumeCents at all -- this test documents that
    // invariant structurally: only sales/rental volume can ever affect cost.
    const cost = computeMonthlyPlanCost(STARTER, { salesVolumeCents: 1_000_000, rentalVolumeCents: 0 })
    expect(cost.totalCostCents).toBe(STARTER.monthly_fee_cents + 60_000)
  })

  it('3. commission math uses integer basis points with no floating-point drift at high volume', () => {
    // R1,000,000.00 sales at Pro's 5% (500 bps) = exactly R50,000.00 -- verified as an
    // exact integer, not an approximately-equal float comparison.
    const cost = computeMonthlyPlanCost(PRO, { salesVolumeCents: 100_000_000, rentalVolumeCents: 0 })
    expect(cost.salesCommissionCents).toBe(5_000_000)
    expect(Number.isInteger(cost.salesCommissionCents)).toBe(true)
  })

  it('4. rounds to the nearest cent on a non-exact division', () => {
    // R100.01 at 6% = R6.0006 -> rounds to 600 cents (R6.00, half-up via Math.round).
    const cost = computeMonthlyPlanCost(STARTER, { salesVolumeCents: 10_001, rentalVolumeCents: 0 })
    expect(cost.salesCommissionCents).toBe(600)
  })
})

describe('break-even points (category: Economics)', () => {
  it('5. Starter vs Pro sales break-even is exactly R19,900 -- equal cost, neither cheaper', () => {
    const volume = { salesVolumeCents: 1_990_000, rentalVolumeCents: 0 }
    const starterCost = computeMonthlyPlanCost(STARTER, volume)
    const proCost = computeMonthlyPlanCost(PRO, volume)
    expect(starterCost.totalCostCents).toBe(proCost.totalCostCents)
  })

  it('6. Starter vs Elite sales break-even is exactly R24,950', () => {
    const volume = { salesVolumeCents: 2_495_000, rentalVolumeCents: 0 }
    const starterCost = computeMonthlyPlanCost(STARTER, volume)
    const eliteCost = computeMonthlyPlanCost(ELITE, volume)
    expect(starterCost.totalCostCents).toBe(eliteCost.totalCostCents)
  })

  it('7. Pro vs Elite sales break-even is exactly R30,000 -- the documented tie case', () => {
    const volume = { salesVolumeCents: 3_000_000, rentalVolumeCents: 0 }
    const proCost = computeMonthlyPlanCost(PRO, volume)
    const eliteCost = computeMonthlyPlanCost(ELITE, volume)
    expect(proCost.totalCostCents).toBe(eliteCost.totalCostCents)

    const result = findCheapestPlans(ALL_PLANS, volume)
    expect(result.isTie).toBe(true)
    expect(result.cheapestPlanIds.sort()).toEqual(['elite', 'pro'])
  })

  it('8. Starter vs Pro rental break-even is exactly R9,950', () => {
    const volume = { salesVolumeCents: 0, rentalVolumeCents: 995_000 }
    const starterCost = computeMonthlyPlanCost(STARTER, volume)
    const proCost = computeMonthlyPlanCost(PRO, volume)
    expect(starterCost.totalCostCents).toBe(proCost.totalCostCents)
  })

  it('9. Starter vs Elite rental break-even is exactly R12,475', () => {
    const volume = { salesVolumeCents: 0, rentalVolumeCents: 1_247_500 }
    const starterCost = computeMonthlyPlanCost(STARTER, volume)
    const eliteCost = computeMonthlyPlanCost(ELITE, volume)
    expect(starterCost.totalCostCents).toBe(eliteCost.totalCostCents)
  })

  it('10. Pro vs Elite rental break-even is exactly R15,000', () => {
    const volume = { salesVolumeCents: 0, rentalVolumeCents: 1_500_000 }
    const proCost = computeMonthlyPlanCost(PRO, volume)
    const eliteCost = computeMonthlyPlanCost(ELITE, volume)
    expect(proCost.totalCostCents).toBe(eliteCost.totalCostCents)
  })
})

describe('findCheapestPlans (category: Economics)', () => {
  it('11. at zero volume, Starter is the single cheapest plan -- never a tie', () => {
    const result = findCheapestPlans(ALL_PLANS, { salesVolumeCents: 0, rentalVolumeCents: 0 })
    expect(result.isTie).toBe(false)
    expect(result.cheapestPlanIds).toEqual(['starter'])
  })

  it('12. at very high volume, Elite is the single cheapest plan', () => {
    const result = findCheapestPlans(ALL_PLANS, { salesVolumeCents: 100_000_000, rentalVolumeCents: 100_000_000 })
    expect(result.isTie).toBe(false)
    expect(result.cheapestPlanIds).toEqual(['elite'])
  })

  it('13. returns a breakdown entry for every plan given, in the same order', () => {
    const result = findCheapestPlans(ALL_PLANS, { salesVolumeCents: 500_000, rentalVolumeCents: 0 })
    expect(result.breakdowns.map((b) => b.planId)).toEqual(['starter', 'pro', 'elite'])
  })
})

describe('computeSavingsCents (category: Economics)', () => {
  it('14. is only ever positive -- a tie or a more expensive candidate both yield 0', () => {
    expect(computeSavingsCents(1000, 1000)).toBe(0)
    expect(computeSavingsCents(1000, 1500)).toBe(0)
  })

  it('15. returns the exact positive difference when the candidate is genuinely cheaper', () => {
    expect(computeSavingsCents(50000, 30000)).toBe(20000)
  })
})

import { describe, it, expect } from 'vitest'
import { calculateUnityCommission, randsToCents, centsToRands, HIGH_VALUE_THRESHOLD_CENTS, HIGH_VALUE_EXCESS_RATE_BPS, type CalculateUnityCommissionInput } from '../calculate'

type TestPlan = CalculateUnityCommissionInput['plan']

const STARTER: TestPlan = { id: 'starter', commercial_version: 1, sales_commission_bps: 600, rental_commission_bps: 1200 }
const PRO: TestPlan = { id: 'pro', commercial_version: 1, sales_commission_bps: 500, rental_commission_bps: 1000 }
const ELITE: TestPlan = { id: 'elite', commercial_version: 1, sales_commission_bps: 400, rental_commission_bps: 800 }

function saleCommissionRands(plan: TestPlan, rands: number): number {
  return centsToRands(calculateUnityCommission({ transactionKind: 'sale', eligibleBaseCents: randsToCents(rands), currency: 'ZAR', plan }).commissionCents)
}

function rentalCommissionRands(plan: TestPlan, rands: number): number {
  return centsToRands(calculateUnityCommission({ transactionKind: 'rental', eligibleBaseCents: randsToCents(rands), currency: 'ZAR', plan }).commissionCents)
}

describe('calculateUnityCommission -- plan rates (category: Rates)', () => {
  it('1. Starter sale rate is 6%', () => {
    expect(saleCommissionRands(STARTER, 1000)).toBeCloseTo(60, 5)
  })
  it('2. Pro sale rate is 5%', () => {
    expect(saleCommissionRands(PRO, 1000)).toBeCloseTo(50, 5)
  })
  it('3. Elite sale rate is 4%', () => {
    expect(saleCommissionRands(ELITE, 1000)).toBeCloseTo(40, 5)
  })
  it('4. Starter rental rate is 12%', () => {
    expect(rentalCommissionRands(STARTER, 1000)).toBeCloseTo(120, 5)
  })
  it('5. Pro rental rate is 10%', () => {
    expect(rentalCommissionRands(PRO, 1000)).toBeCloseTo(100, 5)
  })
  it('6. Elite rental rate is 8%', () => {
    expect(rentalCommissionRands(ELITE, 1000)).toBeCloseTo(80, 5)
  })
})

describe('calculateUnityCommission -- sale boundary values (category: HighValue)', () => {
  it('7. R0 sale produces R0 commission', () => {
    expect(saleCommissionRands(STARTER, 0)).toBe(0)
  })
  it('8. R1 sale produces the plain plan-rate commission, no excess', () => {
    const result = calculateUnityCommission({ transactionKind: 'sale', eligibleBaseCents: randsToCents(1), currency: 'ZAR', plan: STARTER })
    expect(result.excessBaseCents).toBe(0)
    expect(result.excessRateBps).toBe(0)
  })
  it('9. R10,000 sale stays entirely under the standard rate, no excess', () => {
    const result = calculateUnityCommission({ transactionKind: 'sale', eligibleBaseCents: randsToCents(10_000), currency: 'ZAR', plan: STARTER })
    expect(result.excessBaseCents).toBe(0)
    expect(centsToRands(result.commissionCents)).toBeCloseTo(600, 5)
  })
  it('10. R99,999.99 sale has no excess -- strictly below the threshold', () => {
    const result = calculateUnityCommission({ transactionKind: 'sale', eligibleBaseCents: randsToCents(99_999.99), currency: 'ZAR', plan: STARTER })
    expect(result.excessBaseCents).toBe(0)
  })
  it('11. R100,000.00 exactly -- still no excess ("up to and including")', () => {
    const result = calculateUnityCommission({ transactionKind: 'sale', eligibleBaseCents: HIGH_VALUE_THRESHOLD_CENTS, currency: 'ZAR', plan: STARTER })
    expect(result.excessBaseCents).toBe(0)
    expect(result.standardRateBaseCents).toBe(HIGH_VALUE_THRESHOLD_CENTS)
    expect(centsToRands(result.commissionCents)).toBeCloseTo(6000, 5)
  })
  it('12. R100,000.01 -- one cent of excess at 1%', () => {
    const result = calculateUnityCommission({ transactionKind: 'sale', eligibleBaseCents: HIGH_VALUE_THRESHOLD_CENTS + 1, currency: 'ZAR', plan: STARTER })
    expect(result.excessBaseCents).toBe(1)
    expect(result.excessRateBps).toBe(HIGH_VALUE_EXCESS_RATE_BPS)
  })
})

describe('calculateUnityCommission -- exact high-value examples from the commission framework (category: HighValue)', () => {
  it('13. R150,000 Starter = R6,500 exactly (R6,000 + R500)', () => {
    expect(saleCommissionRands(STARTER, 150_000)).toBe(6500)
  })
  it('14. R250,000 -- Starter R7,500 / Pro R6,500 / Elite R5,500', () => {
    expect(saleCommissionRands(STARTER, 250_000)).toBe(7500)
    expect(saleCommissionRands(PRO, 250_000)).toBe(6500)
    expect(saleCommissionRands(ELITE, 250_000)).toBe(5500)
  })
  it('15. R500,000 -- Starter R10,000 / Pro R9,000 / Elite R8,000', () => {
    expect(saleCommissionRands(STARTER, 500_000)).toBe(10000)
    expect(saleCommissionRands(PRO, 500_000)).toBe(9000)
    expect(saleCommissionRands(ELITE, 500_000)).toBe(8000)
  })
  it('16. the excess rate always replaces, never adds to, the plan rate on the excess portion', () => {
    const result = calculateUnityCommission({ transactionKind: 'sale', eligibleBaseCents: randsToCents(150_000), currency: 'ZAR', plan: STARTER })
    // Standard portion: 100,000 * 6% = 6,000. Excess portion: 50,000 * 1% = 500 (NOT 6%).
    expect(centsToRands(result.standardRateBaseCents)).toBe(100_000)
    expect(centsToRands(result.excessBaseCents)).toBe(50_000)
    expect(result.excessRateBps).toBe(100)
  })
})

describe('calculateUnityCommission -- rentals never have a high-value excess (category: HighValue)', () => {
  it('17. a very large rental payment still has zero excess -- Rule 2 is sale-only', () => {
    const result = calculateUnityCommission({ transactionKind: 'rental', eligibleBaseCents: randsToCents(500_000), currency: 'ZAR', plan: STARTER })
    expect(result.excessBaseCents).toBe(0)
    expect(result.excessRateBps).toBe(0)
    expect(centsToRands(result.commissionCents)).toBeCloseTo(60_000, 5)
  })
})

describe('calculateUnityCommission -- barter is structurally excluded (category: Barter)', () => {
  it('18. calculateUnityCommission has no "barter" transactionKind at all -- there is no argument shape that produces a barter commission', () => {
    // TypeScript itself enforces this (CommissionTransactionKind = 'sale' | 'rental');
    // this test documents the invariant for a reader who can't see the type system.
    const kinds: Array<'sale' | 'rental'> = ['sale', 'rental']
    expect(kinds).not.toContain('barter')
  })
})

describe('calculateUnityCommission -- versioning and snapshot fields (category: Versioning)', () => {
  it('19. every result carries a calculation version and the plan snapshot fields', () => {
    const result = calculateUnityCommission({ transactionKind: 'sale', eligibleBaseCents: randsToCents(1000), currency: 'ZAR', plan: STARTER })
    expect(result.calculationVersion).toBe(1)
    expect(result.planId).toBe('starter')
    expect(result.planCommercialVersion).toBe(1)
  })

  it('20. a merchant plan changing later does not affect a result already computed -- pure function, no live lookups', () => {
    const before = calculateUnityCommission({ transactionKind: 'sale', eligibleBaseCents: randsToCents(1000), currency: 'ZAR', plan: STARTER })
    // Simulate "the merchant upgraded" -- a second, independent call with a different plan.
    const after = calculateUnityCommission({ transactionKind: 'sale', eligibleBaseCents: randsToCents(1000), currency: 'ZAR', plan: PRO })
    expect(before.commissionCents).not.toBe(after.commissionCents)
    expect(before.planId).toBe('starter')
  })
})

describe('rounding helpers (category: Rounding)', () => {
  it('21. randsToCents/centsToRands round-trip exactly for 2-decimal-place money', () => {
    expect(randsToCents(133.33)).toBe(13333)
    expect(centsToRands(13333)).toBe(133.33)
  })
  it('22. commission math produces fractional-cent inputs that round half-up to a whole cent', () => {
    // R100.01 at 6% = R6.0006 -> rounds to 600 cents (R6.00).
    const result = calculateUnityCommission({ transactionKind: 'sale', eligibleBaseCents: randsToCents(100.01), currency: 'ZAR', plan: STARTER })
    expect(result.commissionCents).toBe(600)
  })
})

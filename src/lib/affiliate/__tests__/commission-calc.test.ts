import { describe, it, expect } from 'vitest'
import { calculateEligibleSaleBase, calculateCommissionAmount } from '../commission-calc'

describe('calculateEligibleSaleBase (category: Buy/Sell)', () => {
  it('1. subtracts shipping fee from total amount', () => {
    expect(calculateEligibleSaleBase(500, 50)).toBe(450)
  })
  it('2. never returns a negative base even if shipping exceeds total', () => {
    expect(calculateEligibleSaleBase(50, 100)).toBe(0)
  })
  it('3. a zero shipping fee leaves the base unchanged', () => {
    expect(calculateEligibleSaleBase(300, 0)).toBe(300)
  })
})

describe('calculateCommissionAmount (category: Buy/Sell, Rentals)', () => {
  it('4. computes a simple percentage correctly', () => {
    expect(calculateCommissionAmount(1000, 10)).toBe(100)
  })
  it('5. rounds to exact cents, never leaves floating-point drift', () => {
    expect(calculateCommissionAmount(19.99, 8)).toBe(1.6)
  })
  it('6. a 0% rate yields zero commission', () => {
    expect(calculateCommissionAmount(1000, 0)).toBe(0)
  })
  it('7. does not calculate from a theoretical total -- only the eligible base passed in', () => {
    // the function has no concept of "booking total" or "deposit" at all --
    // it only ever sees whatever eligible_base the caller (the RPC) derived.
    expect(calculateCommissionAmount(250, 8)).toBe(20)
  })
})

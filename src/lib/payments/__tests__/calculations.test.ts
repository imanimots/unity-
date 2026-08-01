import { describe, it, expect } from 'vitest'
import {
  calculatePlatformFee,
  calculateMerchantProceeds,
  calculateRefundableAmount,
  isRefundAmountValid,
  calculateDepositCaptureAmount,
  calculateDepositReleaseAmount,
  PLATFORM_FEE_RATE,
} from '../calculations'

describe('calculatePlatformFee', () => {
  it('applies the documented 5% rate', () => {
    expect(PLATFORM_FEE_RATE).toBe(0.05)
    expect(calculatePlatformFee(1000)).toBe(50)
  })

  it('rounds to exact cents', () => {
    expect(calculatePlatformFee(133.33)).toBe(6.67) // 133.33 * 0.05 = 6.6665 -> 6.67
  })

  it('rejects a negative amount', () => {
    expect(() => calculatePlatformFee(-1)).toThrow('Invalid rental amount')
  })
})

describe('calculateMerchantProceeds', () => {
  it('is the rental amount minus the platform fee', () => {
    expect(calculateMerchantProceeds(1000)).toBe(950)
  })
})

describe('calculateRefundableAmount / isRefundAmountValid — mirrors create_refund()', () => {
  it('allows a full refund when nothing has been refunded yet', () => {
    expect(calculateRefundableAmount(1000, 0)).toBe(1000)
    expect(isRefundAmountValid(1000, 0, 1000)).toBe(true)
  })

  it('allows a partial refund that leaves room for more later', () => {
    expect(calculateRefundableAmount(1000, 400)).toBe(600)
    expect(isRefundAmountValid(1000, 400, 600)).toBe(true)
  })

  it('rejects a refund that would exceed the payment amount', () => {
    expect(isRefundAmountValid(1000, 400, 700)).toBe(false)
  })

  it('rejects a zero or negative refund request', () => {
    expect(isRefundAmountValid(1000, 0, 0)).toBe(false)
    expect(isRefundAmountValid(1000, 0, -50)).toBe(false)
  })

  it('never returns a negative refundable amount once fully refunded', () => {
    expect(calculateRefundableAmount(1000, 1000)).toBe(0)
  })
})

describe('deposit release/capture logic', () => {
  it('caps a claimed amount at the deposit itself', () => {
    expect(calculateDepositCaptureAmount(500, 800)).toBe(500)
  })

  it('captures exactly the claimed amount when it fits within the deposit', () => {
    expect(calculateDepositCaptureAmount(500, 150)).toBe(150)
  })

  it('releases whatever remains after a partial capture', () => {
    expect(calculateDepositReleaseAmount(500, 150)).toBe(350)
  })

  it('releases the full deposit when nothing was captured', () => {
    expect(calculateDepositReleaseAmount(500, 0)).toBe(500)
  })

  it('never releases a negative amount when the captured amount exceeds the deposit', () => {
    expect(calculateDepositReleaseAmount(500, 600)).toBe(0)
  })

  it('rejects a negative claimed amount', () => {
    expect(() => calculateDepositCaptureAmount(500, -1)).toThrow('Invalid claimed amount')
  })
})

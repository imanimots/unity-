import { describe, it, expect } from 'vitest'
import { sumWeightPercent, effectiveWeight } from '../weight-math'

describe('sumWeightPercent', () => {
  it('sums a list of weight_percent values that correctly total 100', () => {
    const total = sumWeightPercent([{ weight_percent: 40 }, { weight_percent: 35 }, { weight_percent: 25 }])
    expect(total).toBe(100)
  })

  it('sums a list that does not total 100', () => {
    const total = sumWeightPercent([{ weight_percent: 40 }, { weight_percent: 40 }])
    expect(total).toBe(80)
  })

  it('returns 0 for an empty list', () => {
    expect(sumWeightPercent([])).toBe(0)
  })

  it('returns the single value for a one-item list', () => {
    expect(sumWeightPercent([{ weight_percent: 100 }])).toBe(100)
  })

  it('handles the floating-point near-100 edge case 33.33 + 33.33 + 33.34', () => {
    const total = sumWeightPercent([{ weight_percent: 33.33 }, { weight_percent: 33.33 }, { weight_percent: 33.34 }])
    expect(total).toBeCloseTo(100, 10)
  })

  it('does not silently mask a genuine near-miss like 33.33 x 3 (99.99, not 100)', () => {
    const total = sumWeightPercent([{ weight_percent: 33.33 }, { weight_percent: 33.33 }, { weight_percent: 33.33 }])
    expect(total).toBeCloseTo(99.99, 10)
    expect(total).not.toBeCloseTo(100, 10)
  })
})

describe('effectiveWeight', () => {
  it('computes 50% contribution weight x 40% milestone weight = 20% effective', () => {
    expect(effectiveWeight(50, 40)).toBe(20)
  })

  it('computes 100% contribution weight x 100% milestone weight = 100% effective', () => {
    expect(effectiveWeight(100, 100)).toBe(100)
  })

  it('computes a small, non-round pair correctly', () => {
    expect(effectiveWeight(30, 25)).toBeCloseTo(7.5, 10)
  })

  it('is 0 when contribution weight is 0', () => {
    expect(effectiveWeight(0, 60)).toBe(0)
  })

  it('is 0 when milestone weight is 0', () => {
    expect(effectiveWeight(60, 0)).toBe(0)
  })

  it('is 0 when both are 0', () => {
    expect(effectiveWeight(0, 0)).toBe(0)
  })
})

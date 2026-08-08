import { describe, it, expect } from 'vitest'
import { applyBps } from '../basis-points'

describe('applyBps (category: Rounding)', () => {
  it('1. computes exact whole-cent results with no drift', () => {
    expect(applyBps(100_000, 500)).toBe(5000) // R1000.00 at 5% = R50.00
  })
  it('2. rounds half-up on a fractional-cent result', () => {
    expect(applyBps(13333, 500)).toBe(667) // 13333 * 0.05 = 666.65 -> 667
  })
  it('3. zero amount produces zero regardless of rate', () => {
    expect(applyBps(0, 1200)).toBe(0)
  })
  it('4. zero rate produces zero regardless of amount', () => {
    expect(applyBps(1_000_000, 0)).toBe(0)
  })
})

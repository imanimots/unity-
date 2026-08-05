import { describe, it, expect } from 'vitest'
import { calculateBarterRiskTier } from '../risk'

describe('calculateBarterRiskTier', () => {
  it('returns low when every offered listing is low risk', () => {
    expect(calculateBarterRiskTier(['low', 'low'])).toBe('low')
  })

  it('returns the max tier across mixed inputs', () => {
    expect(calculateBarterRiskTier(['low', 'medium'])).toBe('medium')
    expect(calculateBarterRiskTier(['low', 'medium', 'high'])).toBe('high')
    expect(calculateBarterRiskTier(['high', 'low'])).toBe('high')
  })

  it('returns low for an empty list (no listings offered yet)', () => {
    expect(calculateBarterRiskTier([])).toBe('low')
  })

  it('handles a single listing', () => {
    expect(calculateBarterRiskTier(['high'])).toBe('high')
  })
})

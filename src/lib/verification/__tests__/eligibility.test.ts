import { describe, it, expect } from 'vitest'
import { isKycApproved } from '../eligibility'

describe('isKycApproved', () => {
  it('is true only for "approved"', () => {
    expect(isKycApproved('approved')).toBe(true)
  })

  it.each(['none', 'pending', 'rejected'] as const)('is false for "%s"', (status) => {
    expect(isKycApproved(status)).toBe(false)
  })

  it('is false for null/undefined (no verification on file)', () => {
    expect(isKycApproved(null)).toBe(false)
    expect(isKycApproved(undefined)).toBe(false)
  })
})

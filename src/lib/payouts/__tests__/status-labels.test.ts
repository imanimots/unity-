import { describe, it, expect } from 'vitest'
import { PAYOUT_STATUS_LABELS, PAYOUT_FAILURE_CATEGORIES, PAYOUT_FAILURE_CATEGORY_LABELS, PAYOUT_METHODS, PAYOUT_METHOD_LABELS } from '../status-labels'

describe('payout status labels (category: Lifecycle)', () => {
  it('1. all four lifecycle statuses have a label and badge classes', () => {
    for (const status of ['pending', 'processing', 'paid', 'failed'] as const) {
      expect(PAYOUT_STATUS_LABELS[status].label).toBeTruthy()
      expect(PAYOUT_STATUS_LABELS[status].classes).toBeTruthy()
    }
  })

  it('2. exactly 9 failure categories are defined, matching the approved closed vocabulary', () => {
    expect(PAYOUT_FAILURE_CATEGORIES).toHaveLength(9)
    expect(PAYOUT_FAILURE_CATEGORIES).toContain('other')
  })

  it('3. every failure category has a label', () => {
    for (const c of PAYOUT_FAILURE_CATEGORIES) {
      expect(PAYOUT_FAILURE_CATEGORY_LABELS[c]).toBeTruthy()
    }
  })

  it('4. exactly two payout methods are approved: manual and mock_validation', () => {
    expect(PAYOUT_METHODS).toEqual(['manual', 'mock_validation'])
  })

  it('5. every payout method has a label that never claims a real bank transfer occurred', () => {
    for (const m of PAYOUT_METHODS) {
      const label = PAYOUT_METHOD_LABELS[m].toLowerCase()
      expect(label).not.toMatch(/bank transfer confirmed|peach/i)
    }
  })
})

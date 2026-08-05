import { describe, it, expect } from 'vitest'
import { BARTER_STATUS_LABELS } from '../status-labels'
import type { BarterStatus } from '@/types'

const ALL_STATUSES: BarterStatus[] = [
  'proposed', 'countered', 'accepted', 'preparing', 'in_transit',
  'awaiting_confirmation', 'completed', 'rejected', 'cancelled', 'expired', 'disputed',
]

describe('BARTER_STATUS_LABELS', () => {
  it('has a label and classes for every BarterStatus value', () => {
    for (const status of ALL_STATUSES) {
      expect(BARTER_STATUS_LABELS[status]).toBeDefined()
      expect(BARTER_STATUS_LABELS[status].label.length).toBeGreaterThan(0)
      expect(BARTER_STATUS_LABELS[status].classes.length).toBeGreaterThan(0)
    }
  })

  it('does not define any label for a value outside BarterStatus', () => {
    expect(Object.keys(BARTER_STATUS_LABELS).sort()).toEqual([...ALL_STATUSES].sort())
  })
})

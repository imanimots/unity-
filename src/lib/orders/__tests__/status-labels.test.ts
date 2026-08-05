import { describe, it, expect } from 'vitest'
import { ORDER_STATUS_LABELS } from '../status-labels'
import type { OrderStatus } from '@/types'

const ALL_STATUSES: OrderStatus[] = ['pending', 'paid', 'shipped', 'delivered', 'disputed', 'cancelled']

describe('ORDER_STATUS_LABELS', () => {
  it('has a label and classes for every OrderStatus value', () => {
    for (const status of ALL_STATUSES) {
      expect(ORDER_STATUS_LABELS[status]).toBeDefined()
      expect(ORDER_STATUS_LABELS[status].label.length).toBeGreaterThan(0)
      expect(ORDER_STATUS_LABELS[status].classes.length).toBeGreaterThan(0)
    }
  })

  it('does not define any label for a value outside OrderStatus', () => {
    expect(Object.keys(ORDER_STATUS_LABELS).sort()).toEqual([...ALL_STATUSES].sort())
  })
})

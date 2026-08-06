import { describe, it, expect } from 'vitest'
import { AFFILIATE_COMMISSION_STATUS_LABELS } from '../status-labels'

const ALL_STATUSES = ['pending', 'held', 'approved', 'payout_queued', 'processing', 'paid', 'failed', 'voided', 'reversed'] as const

describe('AFFILIATE_COMMISSION_STATUS_LABELS (category: Admin, Automation)', () => {
  it('1. covers all 9 lifecycle statuses -- pending/held/approved/payout_queued/processing/paid/failed/voided/reversed', () => {
    for (const status of ALL_STATUSES) {
      expect(AFFILIATE_COMMISSION_STATUS_LABELS[status], status).toBeDefined()
      expect(AFFILIATE_COMMISSION_STATUS_LABELS[status].label.length, status).toBeGreaterThan(0)
    }
  })
  it('2. every status has a non-empty style class string', () => {
    for (const status of ALL_STATUSES) {
      expect(AFFILIATE_COMMISSION_STATUS_LABELS[status].classes.length, status).toBeGreaterThan(0)
    }
  })
})

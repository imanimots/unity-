import { describe, it, expect } from 'vitest'
import { DISPUTE_STATUS_LABELS, getDisputeOutcomeLabel } from '../status-labels'
import type { DisputeStatus, DisputeOutcome } from '@/types'

const ALL_STATUSES: DisputeStatus[] = ['open', 'evidence', 'under_review', 'resolved', 'closed', 'cancelled', 'escalated']

describe('DISPUTE_STATUS_LABELS', () => {
  it('has a label and classes for every DisputeStatus value', () => {
    for (const status of ALL_STATUSES) {
      expect(DISPUTE_STATUS_LABELS[status]).toBeDefined()
      expect(DISPUTE_STATUS_LABELS[status].label.length).toBeGreaterThan(0)
      expect(DISPUTE_STATUS_LABELS[status].classes.length).toBeGreaterThan(0)
    }
  })

  it('does not define any label for a value outside DisputeStatus', () => {
    expect(Object.keys(DISPUTE_STATUS_LABELS).sort()).toEqual([...ALL_STATUSES].sort())
  })
})

describe('getDisputeOutcomeLabel', () => {
  const outcomes: DisputeOutcome[] = ['favor_raiser', 'favor_respondent', 'mutual_agreement', 'manual_settlement']

  it('returns a non-empty label for every outcome with no domain framing', () => {
    for (const outcome of outcomes) {
      expect(getDisputeOutcomeLabel(outcome).length).toBeGreaterThan(0)
    }
  })

  it('maps favor_respondent to "Merchant wins" when the raiser is the customer (booking/order framing)', () => {
    expect(getDisputeOutcomeLabel('favor_respondent', { isRaiserMerchant: false })).toBe('Merchant wins')
    expect(getDisputeOutcomeLabel('favor_raiser', { isRaiserMerchant: false })).toBe('Customer wins')
  })

  it('flips correctly when the raiser is the merchant', () => {
    expect(getDisputeOutcomeLabel('favor_raiser', { isRaiserMerchant: true })).toBe('Merchant wins')
    expect(getDisputeOutcomeLabel('favor_respondent', { isRaiserMerchant: true })).toBe('Customer wins')
  })

  it('mutual_agreement and manual_settlement are domain-neutral regardless of framing', () => {
    expect(getDisputeOutcomeLabel('mutual_agreement')).toBe('Mutual agreement')
    expect(getDisputeOutcomeLabel('manual_settlement')).toBe('Manual settlement')
  })
})

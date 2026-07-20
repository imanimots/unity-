export type DisputeStatus = 'open' | 'under_review' | 'resolved' | 'escalated'

export interface MockDispute {
  id: string
  booking_id: string
  raised_by_id: string
  reason: string
  description: string
  status: DisputeStatus
  resolution: string | null
  created_at: string
  evidence_count: number
}

export const MOCK_DISPUTES: MockDispute[] = [
  {
    id: 'dispute-1',
    booking_id: 'booking-r1',
    raised_by_id: 'user-1',
    reason: 'Item not as described',
    description: 'The MacBook had a small crack on the bottom casing that was not visible in the photos and not mentioned in the description. I documented this on collection and reported it immediately.',
    status: 'resolved',
    resolution: 'After reviewing the evidence, Unity issued a partial refund of R150 to the renter. The merchant has been reminded to disclose all cosmetic damage in future listings.',
    created_at: '2026-05-05T14:00:00Z',
    evidence_count: 3,
  },
]

export const DISPUTE_REASONS = [
  'Item damaged on return',
  'Item not as described',
  'Item not received',
  'Late return',
  'No return (item not returned)',
  'Payment issue',
  'Merchant unresponsive',
  'Other',
] as const

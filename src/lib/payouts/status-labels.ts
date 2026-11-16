export type PayoutStatus = 'pending' | 'processing' | 'paid' | 'failed'

export const PAYOUT_STATUS_LABELS: Record<PayoutStatus, { label: string; classes: string }> = {
  pending: { label: 'Pending', classes: 'bg-[#F2EDE8] text-[#6B5B55]' },
  processing: { label: 'Processing', classes: 'bg-amber-100 text-amber-800' },
  paid: { label: 'Paid', classes: 'bg-green-100 text-green-800' },
  failed: { label: 'Failed', classes: 'bg-red-100 text-red-800' },
}

export type PayoutFailureCategory =
  | 'recipient_details_unavailable'
  | 'recipient_details_invalid'
  | 'provider_unavailable'
  | 'provider_declined'
  | 'compliance_review'
  | 'account_restricted'
  | 'source_payment_issue'
  | 'internal_consistency_error'
  | 'other'

export const PAYOUT_FAILURE_CATEGORIES: PayoutFailureCategory[] = [
  'recipient_details_unavailable',
  'recipient_details_invalid',
  'provider_unavailable',
  'provider_declined',
  'compliance_review',
  'account_restricted',
  'source_payment_issue',
  'internal_consistency_error',
  'other',
]

export const PAYOUT_FAILURE_CATEGORY_LABELS: Record<PayoutFailureCategory, string> = {
  recipient_details_unavailable: 'Recipient details unavailable',
  recipient_details_invalid: 'Recipient details invalid',
  provider_unavailable: 'Provider unavailable',
  provider_declined: 'Provider declined',
  compliance_review: 'Compliance review',
  account_restricted: 'Account restricted',
  source_payment_issue: 'Source payment issue',
  internal_consistency_error: 'Internal consistency error',
  other: 'Other',
}

export type PayoutMethod = 'manual' | 'mock_validation'

export const PAYOUT_METHODS: PayoutMethod[] = ['manual', 'mock_validation']

export const PAYOUT_METHOD_LABELS: Record<PayoutMethod, string> = {
  manual: 'Manual payout recorded',
  mock_validation: 'Mock validation (development only, no real funds)',
}

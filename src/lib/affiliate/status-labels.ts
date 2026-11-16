export type AffiliateCommissionStatus =
  | 'pending'
  | 'held'
  | 'approved'
  | 'payout_queued'
  | 'processing'
  | 'paid'
  | 'failed'
  | 'voided'
  | 'reversed'

export const AFFILIATE_COMMISSION_STATUS_LABELS: Record<AffiliateCommissionStatus, { label: string; classes: string }> = {
  pending: { label: 'Pending review', classes: 'bg-amber-100 text-amber-700' },
  held: { label: 'Held', classes: 'bg-red-100 text-red-700' },
  approved: { label: 'Approved', classes: 'bg-blue-100 text-blue-700' },
  payout_queued: { label: 'Payout queued', classes: 'bg-blue-100 text-blue-700' },
  processing: { label: 'Processing payout', classes: 'bg-blue-100 text-blue-700' },
  paid: { label: 'Paid', classes: 'bg-green-100 text-green-700' },
  failed: { label: 'Payout failed', classes: 'bg-red-100 text-red-700' },
  voided: { label: 'Voided', classes: 'bg-[#F2EDE8] text-[#9B8B85]' },
  reversed: { label: 'Reversed', classes: 'bg-red-100 text-red-700' },
}

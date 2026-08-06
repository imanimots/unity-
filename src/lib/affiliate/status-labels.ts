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
  pending: { label: 'Pending review', classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  held: { label: 'Held', classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  approved: { label: 'Approved', classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  payout_queued: { label: 'Payout queued', classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  processing: { label: 'Processing payout', classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  paid: { label: 'Paid', classes: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  failed: { label: 'Payout failed', classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  voided: { label: 'Voided', classes: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  reversed: { label: 'Reversed', classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
}

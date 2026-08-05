import type { DisputeStatus, DisputeOutcome } from '@/types'

export const DISPUTE_STATUS_LABELS: Record<DisputeStatus, { label: string; classes: string }> = {
  open: { label: 'Open', classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  evidence: { label: 'Evidence requested', classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  under_review: { label: 'Under review', classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  resolved: { label: 'Resolved', classes: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
  closed: { label: 'Closed', classes: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  cancelled: { label: 'Cancelled', classes: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  escalated: { label: 'Escalated', classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
}

/**
 * outcome values are generic (favor_raiser/favor_respondent), not
 * literal "merchant_wins"/"customer_wins" -- barter has no merchant/
 * customer distinction. isRaiserMerchant lets a booking/order caller
 * pick the domain-appropriate label; barter callers pass neither and
 * get the party-neutral label. See docs/DISPUTE_SYSTEM.md.
 */
export function getDisputeOutcomeLabel(outcome: DisputeOutcome, opts?: { isRaiserMerchant?: boolean }): string {
  switch (outcome) {
    case 'favor_raiser':
      return opts?.isRaiserMerchant === undefined ? 'In favor of the party who raised the dispute' : opts.isRaiserMerchant ? 'Merchant wins' : 'Customer wins'
    case 'favor_respondent':
      return opts?.isRaiserMerchant === undefined ? 'In favor of the other party' : opts.isRaiserMerchant ? 'Customer wins' : 'Merchant wins'
    case 'mutual_agreement':
      return 'Mutual agreement'
    case 'manual_settlement':
      return 'Manual settlement'
  }
}

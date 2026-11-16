import type { BarterStatus } from '@/types'

export const BARTER_STATUS_LABELS: Record<BarterStatus, { label: string; classes: string }> = {
  proposed: { label: 'Awaiting response', classes: 'bg-amber-100 text-amber-700' },
  countered: { label: 'Countered', classes: 'bg-amber-100 text-amber-700' },
  accepted: { label: 'Accepted', classes: 'bg-blue-100 text-blue-700' },
  preparing: { label: 'Preparing', classes: 'bg-blue-100 text-blue-700' },
  in_transit: { label: 'In transit', classes: 'bg-blue-100 text-blue-700' },
  awaiting_confirmation: { label: 'Awaiting confirmation', classes: 'bg-amber-100 text-amber-700' },
  completed: { label: 'Completed', classes: 'bg-[#F2EDE8] text-[#6B5B55]' },
  rejected: { label: 'Declined', classes: 'bg-[#F2EDE8] text-[#9B8B85]' },
  cancelled: { label: 'Cancelled', classes: 'bg-[#F2EDE8] text-[#9B8B85]' },
  expired: { label: 'Expired', classes: 'bg-[#F2EDE8] text-[#9B8B85]' },
  disputed: { label: 'Disputed', classes: 'bg-red-100 text-red-700' },
}

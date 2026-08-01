export type BookingLifecycleStatus =
  | 'requested'
  | 'accepted'
  | 'rejected'
  | 'expired'
  | 'cancelled_by_renter'
  | 'cancelled_by_merchant'
  | 'active'
  | 'return_pending'
  | 'returned'
  | 'completed'
  | 'cancelled'
  | 'disputed'

export const BOOKING_STATUS_LABELS: Record<BookingLifecycleStatus, { label: string; classes: string }> = {
  requested: { label: 'Awaiting response', classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  accepted: { label: 'Accepted', classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  rejected: { label: 'Declined', classes: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  expired: { label: 'Expired', classes: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  cancelled_by_renter: { label: 'Cancelled by renter', classes: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  cancelled_by_merchant: { label: 'Cancelled by merchant', classes: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  active: { label: 'Active rental', classes: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  return_pending: { label: 'Return pending confirmation', classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  returned: { label: 'Returned', classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  completed: { label: 'Completed', classes: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  cancelled: { label: 'Cancelled', classes: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  disputed: { label: 'Disputed', classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
}

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
  requested: { label: 'Awaiting response', classes: 'bg-amber-100 text-amber-700' },
  accepted: { label: 'Accepted', classes: 'bg-blue-100 text-blue-700' },
  rejected: { label: 'Declined', classes: 'bg-[#F2EDE8] text-[#9B8B85]' },
  expired: { label: 'Expired', classes: 'bg-[#F2EDE8] text-[#9B8B85]' },
  cancelled_by_renter: { label: 'Cancelled by renter', classes: 'bg-[#F2EDE8] text-[#9B8B85]' },
  cancelled_by_merchant: { label: 'Cancelled by merchant', classes: 'bg-[#F2EDE8] text-[#9B8B85]' },
  active: { label: 'Active rental', classes: 'bg-green-100 text-green-700' },
  return_pending: { label: 'Return pending confirmation', classes: 'bg-amber-100 text-amber-700' },
  returned: { label: 'Returned', classes: 'bg-blue-100 text-blue-700' },
  completed: { label: 'Completed', classes: 'bg-[#F2EDE8] text-[#6B5B55]' },
  cancelled: { label: 'Cancelled', classes: 'bg-[#F2EDE8] text-[#9B8B85]' },
  disputed: { label: 'Disputed', classes: 'bg-red-100 text-red-700' },
}

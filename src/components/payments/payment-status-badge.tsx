import type { PaymentStatus } from '@/lib/checkout/financial-readiness'

/**
 * Provider-neutral -- renders purely from the normalized PaymentStatus
 * enum, never a provider-specific string. Safe for both renter and
 * merchant surfaces (no raw provider reference, no internal codes).
 */
const STATUS_COPY: Record<NonNullable<PaymentStatus>, { label: string; classes: string }> = {
  pending: { label: 'Pending', classes: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  authorised: { label: 'Authorized', classes: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  captured: { label: 'Paid', classes: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  partially_captured: { label: 'Partially paid', classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  released: { label: 'Released', classes: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  refunded: { label: 'Refunded', classes: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  partially_refunded: { label: 'Partially refunded', classes: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
  failed: { label: 'Failed', classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  cancelled: { label: 'Cancelled', classes: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  expired: { label: 'Expired', classes: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]' },
  chargeback: { label: 'Chargeback', classes: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
}

export function PaymentStatusBadge({ status, fallbackLabel = 'Not started' }: { status: PaymentStatus; fallbackLabel?: string }) {
  if (!status) {
    return (
      <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]">
        {fallbackLabel}
      </span>
    )
  }
  const copy = STATUS_COPY[status]
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${copy.classes}`}>{copy.label}</span>
}

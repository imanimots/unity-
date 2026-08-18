import { useTranslations } from 'next-intl'
import type { PaymentStatus } from '@/lib/checkout/financial-readiness'

/**
 * Provider-neutral -- renders purely from the normalized PaymentStatus
 * enum, never a provider-specific string. Safe for both renter and
 * merchant surfaces (no raw provider reference, no internal codes).
 */
const STATUS_CLASSES: Record<NonNullable<PaymentStatus>, string> = {
  pending: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
  authorised: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  captured: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  partially_captured: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  released: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
  refunded: 'bg-[#F2EDE8] text-[#6B5B55] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
  partially_refunded: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  cancelled: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
  expired: 'bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]',
  chargeback: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
}

export function PaymentStatusBadge({ status, fallbackLabel }: { status: PaymentStatus; fallbackLabel?: string }) {
  const t = useTranslations('rent.paymentStatus')
  if (!status) {
    return (
      <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-[#F2EDE8] text-[#9B8B85] dark:bg-[#2A1A1A] dark:text-[#9B8B85]">
        {fallbackLabel ?? t('notStarted')}
      </span>
    )
  }
  return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${STATUS_CLASSES[status]}`}>{t(status)}</span>
}

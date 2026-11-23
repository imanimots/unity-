import { useTranslations } from 'next-intl'
import { BOOKING_STATUS_LABELS, type BookingLifecycleStatus } from '@/lib/bookings/status-labels'
import { BOOKING_STATUS_GUIDANCE } from '@/lib/help/status-guidance'

interface Props {
  status: BookingLifecycleStatus
  role?: 'renter' | 'merchant'
}

/**
 * Mirrors OrderStatusBadge's pattern exactly -- one shared component
 * for both /dashboard/renter/bookings and /dashboard/merchant/bookings
 * rather than the guidance line being written twice.
 */
export function BookingStatusBadge({ status, role }: Props) {
  const t = useTranslations('rent')
  const sc = BOOKING_STATUS_LABELS[status]
  const guidance = role ? BOOKING_STATUS_GUIDANCE[status]?.[role] : undefined
  return (
    <div className="text-right">
      <span className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full ${sc.classes}`}>{t(`status.${status}`)}</span>
      {guidance && <p className="text-xs text-[#9B8B85] mt-1 max-w-[220px]">{guidance}</p>}
    </div>
  )
}

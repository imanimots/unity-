import { useTranslations } from 'next-intl'
import { ORDER_STATUS_LABELS } from '@/lib/orders/status-labels'
import { ORDER_STATUS_GUIDANCE } from '@/lib/help/status-guidance'
import type { OrderStatus } from '@/types'

interface Props {
  status: OrderStatus
  /** Role-aware guidance line beneath the badge -- omitted entirely
   * (not just the badge) when no role is known, so this component
   * stays safe to use anywhere a role genuinely isn't available yet. */
  role?: 'buyer' | 'seller'
}

export function OrderStatusBadge({ status, role }: Props) {
  const t = useTranslations('buy.status')
  const { classes } = ORDER_STATUS_LABELS[status]
  return (
    <div>
      <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${classes}`}>{t(status)}</span>
      {role && <p className="text-xs text-[#9B8B85] mt-1">{ORDER_STATUS_GUIDANCE[status][role]}</p>}
    </div>
  )
}

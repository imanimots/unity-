import { ORDER_STATUS_LABELS } from '@/lib/orders/status-labels'
import type { OrderStatus } from '@/types'

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const { label, classes } = ORDER_STATUS_LABELS[status]
  return <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${classes}`}>{label}</span>
}

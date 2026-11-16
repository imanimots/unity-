import type { OrderStatus } from '@/types'

export const ORDER_STATUS_LABELS: Record<OrderStatus, { label: string; classes: string }> = {
  pending: { label: 'Awaiting payment', classes: 'bg-amber-100 text-amber-700' },
  paid: { label: 'Paid — awaiting shipment', classes: 'bg-blue-100 text-blue-700' },
  shipped: { label: 'Shipped', classes: 'bg-blue-100 text-blue-700' },
  delivered: { label: 'Delivered', classes: 'bg-[#F2EDE8] text-[#6B5B55]' },
  disputed: { label: 'Disputed', classes: 'bg-red-100 text-red-700' },
  cancelled: { label: 'Cancelled', classes: 'bg-[#F2EDE8] text-[#9B8B85]' },
}

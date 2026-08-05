import { BARTER_STATUS_LABELS } from '@/lib/barter/status-labels'
import type { BarterStatus } from '@/types'

export function BarterStatusBadge({ status }: { status: BarterStatus }) {
  const { label, classes } = BARTER_STATUS_LABELS[status]
  return <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${classes}`}>{label}</span>
}

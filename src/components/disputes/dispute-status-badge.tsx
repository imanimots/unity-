import { DISPUTE_STATUS_LABELS } from '@/lib/disputes/status-labels'
import type { DisputeStatus } from '@/types'

export function DisputeStatusBadge({ status }: { status: DisputeStatus }) {
  const { label, classes } = DISPUTE_STATUS_LABELS[status]
  return <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${classes}`}>{label}</span>
}

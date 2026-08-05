import type { DisputeHistoryEntry } from '@/types'

const EVENT_LABELS: Record<string, string> = {
  dispute_opened: 'Dispute opened',
  dispute_assigned: 'Assigned to an admin',
  dispute_review_started: 'Moved into review',
  dispute_evidence_requested: 'Evidence requested',
  evidence_uploaded: 'Evidence uploaded',
  dispute_resolved: 'Resolved',
  dispute_closed: 'Closed',
  dispute_cancelled: 'Cancelled',
}

const ACTOR_LABELS: Record<DisputeHistoryEntry['actor_role'], string> = {
  raiser: 'Party who raised the dispute',
  respondent: 'Other party',
  admin: 'Unity admin',
  system: 'System',
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function DisputeTimeline({ history }: { history: DisputeHistoryEntry[] }) {
  if (history.length === 0) return null

  return (
    <div>
      <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">Timeline</h2>
      <ol className="space-y-4">
        {history.map((entry) => (
          <li key={entry.id} className="flex gap-3">
            <div className="w-1.5 h-1.5 rounded-full bg-[#8B1A1A] mt-2 shrink-0" />
            <div>
              <p className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
                {EVENT_LABELS[entry.event_type] ?? entry.event_type}
              </p>
              <p className="text-xs text-[#9B8B85]">
                {ACTOR_LABELS[entry.actor_role]} · {formatDateTime(entry.created_at)}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

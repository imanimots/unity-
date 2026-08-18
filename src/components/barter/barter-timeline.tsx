import type { BarterHistoryEntry } from '@/types'

const EVENT_LABELS: Record<string, string> = {
  barter_proposed: 'Trade proposed',
  barter_countered: 'Counter-offer sent',
  barter_accepted: 'Trade accepted',
  barter_rejected: 'Trade declined',
  barter_cancelled: 'Trade cancelled',
  barter_auto_cancelled_listing_locked: 'Automatically cancelled — a listing was committed to another accepted trade',
  barter_expired: 'Proposal expired',
  // Step 11 Phase 4
  barter_progress_marked: 'Progress updated',
  barter_completion_confirmed: 'Completion confirmed by a party',
  barter_completed: 'Trade completed',
  barter_admin_hold_set: 'Suspended by an admin',
  barter_admin_hold_released: 'Reopened by an admin',
  barter_admin_cancelled: 'Cancelled by an admin',
}

const ACTOR_LABELS: Record<BarterHistoryEntry['actor_role'], string> = {
  party_a: 'Listing owner',
  party_b: 'Proposer',
  system: 'System',
  admin: 'Unity admin',
}

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

interface BarterTimelineLabels {
  title: string
  events: Partial<Record<string, string>>
  actors: Partial<Record<BarterHistoryEntry['actor_role'], string>>
  formatDateTime?: (iso: string) => string
}

/**
 * Rendered both inside [locale] (via BarterAgreementView) AND directly by
 * admin/barter/[id]/page.tsx, which has no NextIntlClientProvider at all.
 * Server-resolved label overrides instead of useTranslations() -- admin
 * call sites omit `labels` and keep the English literals above.
 */
export function BarterTimeline({ history, labels }: { history: BarterHistoryEntry[]; labels?: BarterTimelineLabels }) {
  if (history.length === 0) return null
  const fmt = labels?.formatDateTime ?? formatDateTime

  return (
    <div>
      <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">{labels?.title ?? 'Timeline'}</h2>
      <ol className="space-y-4">
        {history.map((entry) => (
          <li key={entry.id} className="flex gap-3">
            <div className="w-1.5 h-1.5 rounded-full bg-[#8B1A1A] mt-2 shrink-0" />
            <div>
              <p className="text-sm font-medium text-[#1A0A0A] dark:text-[#F5F0ED]">
                {labels?.events[entry.event_type] ?? EVENT_LABELS[entry.event_type] ?? entry.event_type}
              </p>
              <p className="text-xs text-[#9B8B85]">
                {labels?.actors[entry.actor_role] ?? ACTOR_LABELS[entry.actor_role]} · {fmt(entry.created_at)}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

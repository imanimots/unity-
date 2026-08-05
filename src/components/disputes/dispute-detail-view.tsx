import { DisputeStatusBadge } from './dispute-status-badge'
import { DisputeEvidencePanel } from './dispute-evidence-panel'
import { ChatThread } from '@/components/messaging/chat-thread'
import { DisputeTimeline } from './dispute-timeline'
import { getDisputeOutcomeLabel } from '@/lib/disputes/status-labels'
import type { Dispute, DisputeEvidence, DisputeHistoryEntry } from '@/types'

interface DisputeDetailViewProps {
  dispute: Dispute
  history: DisputeHistoryEntry[]
  evidence: DisputeEvidence[]
  currentUserId: string
  /**
   * 'participant' shows upload/send controls (the page that renders this
   * with viewerRole='participant' only ever does so after an RLS-scoped
   * query already proved the viewer is a party). 'admin' is read-only for
   * evidence/chat — an admin has no participant-write RLS policy on
   * either dispute_evidence/storage or messages, so showing those
   * controls to an admin would silently fail server-side; Part E's admin
   * capabilities don't include posting as if a party anyway.
   */
  viewerRole: 'participant' | 'admin'
  /** Extra content rendered above the timeline — the admin action buttons on the admin page, nothing on the participant page. */
  adminActions?: React.ReactNode
}

const TERMINAL_STATUSES = ['resolved', 'closed', 'cancelled']

/**
 * The one shared dispute view, adapting to whichever role is looking at
 * it (raiser/respondent/admin) rather than three near-duplicate pages —
 * the admin page just renders it with an extra adminActions slot. The
 * chat panel renders the shared ChatThread (Step 11 Phase 3) against
 * the dispute's own underlying transaction -- there is no separate
 * "dispute thread"; messages sent here are tagged with this dispute's
 * id but land in the same conversation the transaction's own chat
 * shows (see src/lib/messaging/service.ts).
 */
export function DisputeDetailView({ dispute, history, evidence, currentUserId, viewerRole, adminActions }: DisputeDetailViewProps) {
  const isActive = !TERMINAL_STATUSES.includes(dispute.status) && viewerRole === 'participant'
  const transactionType = dispute.booking_id ? 'booking' : dispute.order_id ? 'order' : 'barter'
  const transactionId = dispute.booking_id ?? dispute.order_id ?? dispute.barter_agreement_id ?? ''

  return (
    <div className="space-y-8">
      <div>
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-xl font-extrabold text-[#1A0A0A] dark:text-[#F5F0ED]">{dispute.title}</h1>
          <DisputeStatusBadge status={dispute.status} />
        </div>
        <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] whitespace-pre-wrap">{dispute.description}</p>
      </div>

      <div>
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Requested resolution</h2>
        <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED] whitespace-pre-wrap">{dispute.requested_resolution}</p>
      </div>

      {dispute.status === 'resolved' || dispute.status === 'closed' ? (
        <div>
          <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-2">Outcome</h2>
          <p className="text-sm text-[#1A0A0A] dark:text-[#F5F0ED]">{dispute.outcome ? getDisputeOutcomeLabel(dispute.outcome) : '—'}</p>
          {dispute.resolution_notes && <p className="text-sm text-[#6B5B55] dark:text-[#9B8B85] mt-1 whitespace-pre-wrap">{dispute.resolution_notes}</p>}
        </div>
      ) : null}

      {adminActions}

      <DisputeEvidencePanel disputeId={dispute.id} currentUserId={currentUserId} evidence={evidence} canUpload={isActive} />

      <div>
        <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85] mb-4">Messages</h2>
        <ChatThread
          transactionType={transactionType}
          transactionId={transactionId}
          currentUserId={currentUserId}
          canSend={viewerRole === 'participant'}
          disputeId={dispute.id}
          variant="embedded"
          useAdminEndpoint={viewerRole === 'admin'}
        />
      </div>

      <DisputeTimeline history={history} />
    </div>
  )
}

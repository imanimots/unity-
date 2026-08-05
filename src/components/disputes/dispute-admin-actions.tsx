'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { primaryButtonClass, secondaryButtonClass, inputClass } from '@/components/admin/ui'
import type { DisputeStatus } from '@/types'

interface DisputeAdminActionsProps {
  disputeId: string
  status: DisputeStatus
  currentAdminId: string
  assignedAdminId: string | null
}

const OUTCOMES: { value: string; label: string }[] = [
  { value: 'favor_raiser', label: 'In favor of the party who raised the dispute' },
  { value: 'favor_respondent', label: 'In favor of the other party' },
  { value: 'mutual_agreement', label: 'Mutual agreement' },
  { value: 'manual_settlement', label: 'Manual settlement' },
]

/**
 * Admin-only action panel -- assign/start-review/request-evidence/
 * resolve/close/cancel, one call per action per the brief's Part H
 * (admin-only, RPC/route-mediated, never a direct table write). No
 * financial execution here -- resolve only records the outcome.
 */
export function DisputeAdminActions({ disputeId, status, currentAdminId, assignedAdminId }: DisputeAdminActionsProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [outcome, setOutcome] = useState(OUTCOMES[0].value)
  const [resolutionNotes, setResolutionNotes] = useState('')
  const [cancellationReason, setCancellationReason] = useState('')

  async function call(path: string, body: Record<string, unknown> = {}) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, idempotency_key: crypto.randomUUID() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Action failed')
        return
      }
      router.refresh()
    } catch {
      setError('Action failed — please try again')
    } finally {
      setBusy(false)
    }
  }

  const isTerminal = ['resolved', 'closed', 'cancelled'].includes(status)

  return (
    <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-4 bg-[#FAF8F5] dark:bg-[#1A1010]">
      <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85]">Admin actions</h2>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {!isTerminal && (
        <div className="flex flex-wrap gap-2">
          {assignedAdminId !== currentAdminId && (
            <button
              disabled={busy}
              onClick={() => call(`/api/admin/disputes/${disputeId}/assign`, { assignee_admin_id: currentAdminId })}
              className={secondaryButtonClass}
            >
              Assign to me
            </button>
          )}
          {(status === 'open' || status === 'evidence') && (
            <button disabled={busy} onClick={() => call(`/api/admin/disputes/${disputeId}/start-review`)} className={secondaryButtonClass}>
              Start review
            </button>
          )}
          {(status === 'open' || status === 'under_review') && (
            <button disabled={busy} onClick={() => call(`/api/admin/disputes/${disputeId}/request-evidence`, { note })} className={secondaryButtonClass}>
              Request evidence
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => call(`/api/admin/disputes/${disputeId}/cancel`, { cancellation_reason: cancellationReason })}
            className={secondaryButtonClass}
          >
            Cancel dispute
          </button>
        </div>
      )}

      {(status === 'open' || status === 'under_review') && (
        <div>
          <label htmlFor="admin-note" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1">
            Note (for &quot;request evidence&quot;)
          </label>
          <input id="admin-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} className={`w-full ${inputClass}`} />
        </div>
      )}

      {status === 'under_review' && (
        <div className="space-y-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
          <div>
            <label htmlFor="admin-outcome" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1">
              Outcome
            </label>
            <select id="admin-outcome" value={outcome} onChange={(e) => setOutcome(e.target.value)} className={`w-full ${inputClass}`}>
              {OUTCOMES.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="admin-resolution-notes" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1">
              Resolution notes
            </label>
            <textarea id="admin-resolution-notes" rows={3} value={resolutionNotes} onChange={(e) => setResolutionNotes(e.target.value)} className={`w-full ${inputClass}`} />
          </div>
          <button
            disabled={busy}
            onClick={() => call(`/api/admin/disputes/${disputeId}/resolve`, { outcome, resolution_notes: resolutionNotes })}
            className={primaryButtonClass}
          >
            Resolve dispute
          </button>
        </div>
      )}

      {status === 'resolved' && (
        <button disabled={busy} onClick={() => call(`/api/admin/disputes/${disputeId}/close`)} className={primaryButtonClass}>
          Close dispute
        </button>
      )}

      {!isTerminal && (
        <div className="border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
          <label htmlFor="admin-cancel-reason" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1">
            Cancellation reason (optional)
          </label>
          <input id="admin-cancel-reason" type="text" value={cancellationReason} onChange={(e) => setCancellationReason(e.target.value)} className={`w-full ${inputClass}`} />
        </div>
      )}
    </div>
  )
}

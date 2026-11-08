'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { primaryButtonClass, secondaryButtonClass, inputClass } from '@/components/admin/ui'
import type { DisputeStatus } from '@/types'

interface FinancialDisposition {
  disposition_type: string
  status: string
  amount: string | number | null
}

interface DisputeAdminActionsProps {
  disputeId: string
  status: DisputeStatus
  currentAdminId: string
  assignedAdminId: string | null
  /** E28: null for order/barter/RTB disputes -- financial disposition only applies to booking disputes. */
  bookingId: string | null
  /** E28: the dispute's existing 1:1 financial disposition, if one has been recorded. */
  financialDisposition: FinancialDisposition | null
}

const OUTCOMES: { value: string; label: string }[] = [
  { value: 'favor_raiser', label: 'In favor of the party who raised the dispute' },
  { value: 'favor_respondent', label: 'In favor of the other party' },
  { value: 'mutual_agreement', label: 'Mutual agreement' },
  { value: 'manual_settlement', label: 'Manual settlement' },
]

const DISPOSITION_TYPES: { value: string; label: string }[] = [
  { value: 'no_financial_adjustment', label: 'No financial adjustment' },
  { value: 'refund_required', label: 'Refund required (from the booking payment)' },
  { value: 'manual_financial_settlement', label: 'Manual financial settlement (external to the refund path)' },
]

/**
 * Admin-only action panel -- assign/start-review/request-evidence/
 * resolve/close/cancel, one call per action per the brief's Part H
 * (admin-only, RPC/route-mediated, never a direct table write). No
 * financial execution here -- resolve only records the outcome.
 *
 * E28: for a BOOKING dispute (bookingId !== null), resolving now also
 * requires an explicit financial disposition -- it must be impossible
 * for a financially ambiguous outcome to silently mean "normal payout
 * flow resumes". A pending refund_required/manual_financial_
 * settlement disposition can be marked complete below once the admin
 * has verified the money actually moved outside this system -- this
 * never calls a payment provider or re-executes the refund itself.
 */
export function DisputeAdminActions({ disputeId, status, currentAdminId, assignedAdminId, bookingId, financialDisposition }: DisputeAdminActionsProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [outcome, setOutcome] = useState(OUTCOMES[0].value)
  const [resolutionNotes, setResolutionNotes] = useState('')
  const [cancellationReason, setCancellationReason] = useState('')
  const [dispositionType, setDispositionType] = useState(DISPOSITION_TYPES[0].value)
  const [dispositionAmount, setDispositionAmount] = useState('')
  const [dispositionReason, setDispositionReason] = useState('')
  const [completionNotes, setCompletionNotes] = useState('')

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

          {bookingId !== null && (
            <div className="space-y-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-3">
              <p className="text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85]">
                Financial disposition (required) -- what money must happen because of this decision, separate from the outcome above.
              </p>
              <div>
                <label htmlFor="admin-disposition-type" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1">
                  Disposition
                </label>
                <select id="admin-disposition-type" value={dispositionType} onChange={(e) => setDispositionType(e.target.value)} className={`w-full ${inputClass}`}>
                  {DISPOSITION_TYPES.map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
              </div>
              {dispositionType !== 'no_financial_adjustment' && (
                <div>
                  <label htmlFor="admin-disposition-amount" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1">
                    Amount (ZAR)
                  </label>
                  <input
                    id="admin-disposition-amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={dispositionAmount}
                    onChange={(e) => setDispositionAmount(e.target.value)}
                    className={`w-full ${inputClass}`}
                  />
                </div>
              )}
              <div>
                <label htmlFor="admin-disposition-reason" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1">
                  Disposition reason (required)
                </label>
                <textarea id="admin-disposition-reason" rows={2} value={dispositionReason} onChange={(e) => setDispositionReason(e.target.value)} className={`w-full ${inputClass}`} />
              </div>
            </div>
          )}

          <button
            disabled={
              busy ||
              (bookingId !== null &&
                (dispositionReason.trim().length === 0 || (dispositionType !== 'no_financial_adjustment' && Number(dispositionAmount) <= 0)))
            }
            onClick={() =>
              call(`/api/admin/disputes/${disputeId}/resolve`, {
                outcome,
                resolution_notes: resolutionNotes,
                ...(bookingId !== null
                  ? {
                      financial_disposition_type: dispositionType,
                      financial_disposition_amount: dispositionType === 'no_financial_adjustment' ? undefined : Number(dispositionAmount),
                      financial_disposition_reason: dispositionReason,
                    }
                  : {}),
              })
            }
            className={primaryButtonClass}
          >
            Resolve dispute
          </button>
        </div>
      )}

      {bookingId !== null && financialDisposition && financialDisposition.status === 'pending' && (
        <div className="space-y-3 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
            Financial disposition pending: {financialDisposition.disposition_type.replace(/_/g, ' ')}
            {financialDisposition.amount != null ? ` (R${financialDisposition.amount})` : ''} -- payout is blocked until this is marked complete.
          </p>
          <div>
            <label htmlFor="admin-completion-notes" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1">
              Completion notes (confirm the money has actually moved, e.g. via the payment provider dashboard)
            </label>
            <textarea id="admin-completion-notes" rows={2} value={completionNotes} onChange={(e) => setCompletionNotes(e.target.value)} className={`w-full ${inputClass}`} />
          </div>
          <button
            disabled={busy}
            onClick={() => call(`/api/admin/disputes/${disputeId}/complete-financial-disposition`, { completion_notes: completionNotes })}
            className={primaryButtonClass}
          >
            Mark financial disposition complete
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

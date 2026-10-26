'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { primaryButtonClass, secondaryButtonClass, inputClass } from '@/components/admin/ui'
import { SOFT_STATUSES, SUPPORT_CASE_PRIORITIES, isActiveSupportCaseStatus } from '@/lib/support/types'

interface SupportCaseAdminActionsProps {
  caseId: string
  status: string
  priority: string
  currentAdminId: string
}

/**
 * Admin-only action panel -- assign/priority/soft-status/escalate/
 * resolve/close/reopen/add-note, one call per action (Part 18), always
 * via the server RPC/route (never a direct table write). No typed-
 * confirmation flow in A2 -- just a plain reason/summary field where
 * the server requires one (Part 17).
 */
export function SupportCaseAdminActions({ caseId, status, priority, currentAdminId }: SupportCaseAdminActionsProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [escalationReason, setEscalationReason] = useState('')
  const [resolutionSummary, setResolutionSummary] = useState('')
  const [closeReason, setCloseReason] = useState('')
  const [reopenReason, setReopenReason] = useState('')
  const [selectedPriority, setSelectedPriority] = useState(priority)

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

  const isActive = isActiveSupportCaseStatus(status as never)
  const isSoft = (SOFT_STATUSES as readonly string[]).includes(status)

  return (
    <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-4 bg-[#FAF8F5] dark:bg-[#1A1010]">
      <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85]">Admin actions</h2>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {/* Assign */}
      <div className="flex flex-wrap gap-2">
        <button disabled={busy} onClick={() => call(`/api/admin/support/${caseId}/assign`, { assignee_admin_id: currentAdminId })} className={secondaryButtonClass}>
          Assign to me
        </button>
      </div>

      {/* Priority */}
      <div className="flex items-end gap-2">
        <div>
          <label htmlFor="support-priority" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1">Priority</label>
          <select id="support-priority" value={selectedPriority} onChange={(e) => setSelectedPriority(e.target.value)} className={inputClass}>
            {SUPPORT_CASE_PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <button disabled={busy || selectedPriority === priority} onClick={() => call(`/api/admin/support/${caseId}/priority`, { priority: selectedPriority })} className={secondaryButtonClass}>
          Update priority
        </button>
      </div>

      {isSoft && (
        <div className="flex flex-wrap gap-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
          {status !== 'in_progress' && (
            <button disabled={busy} onClick={() => call(`/api/admin/support/${caseId}/status`, { target_status: 'in_progress' })} className={secondaryButtonClass}>
              Start progress
            </button>
          )}
          {status !== 'waiting_on_user' && (
            <button disabled={busy} onClick={() => call(`/api/admin/support/${caseId}/status`, { target_status: 'waiting_on_user' })} className={secondaryButtonClass}>
              Mark waiting on user
            </button>
          )}
          {status !== 'open' && (
            <button disabled={busy} onClick={() => call(`/api/admin/support/${caseId}/status`, { target_status: 'open' })} className={secondaryButtonClass}>
              Mark open
            </button>
          )}
        </div>
      )}

      {isActive && (
        <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
          <label htmlFor="support-escalation-reason" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85]">Escalation reason</label>
          <input id="support-escalation-reason" type="text" value={escalationReason} onChange={(e) => setEscalationReason(e.target.value)} className={`w-full ${inputClass}`} />
          <button disabled={busy || !escalationReason.trim() || status === 'escalated'} onClick={() => call(`/api/admin/support/${caseId}/escalate`, { reason: escalationReason })} className={secondaryButtonClass}>
            Escalate case
          </button>
        </div>
      )}

      {isActive && (
        <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
          <label htmlFor="support-resolution-summary" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85]">Resolution summary</label>
          <textarea id="support-resolution-summary" rows={3} value={resolutionSummary} onChange={(e) => setResolutionSummary(e.target.value)} className={`w-full ${inputClass}`} />
          <button disabled={busy || !resolutionSummary.trim()} onClick={() => call(`/api/admin/support/${caseId}/resolve`, { resolution_summary: resolutionSummary })} className={primaryButtonClass}>
            Resolve case
          </button>
        </div>
      )}

      {status !== 'closed' && (
        <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
          <label htmlFor="support-close-reason" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85]">
            Close reason {status !== 'resolved' ? '(required — closing without resolution)' : '(optional)'}
          </label>
          <input id="support-close-reason" type="text" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} className={`w-full ${inputClass}`} />
          <button disabled={busy || (status !== 'resolved' && !closeReason.trim())} onClick={() => call(`/api/admin/support/${caseId}/close`, { reason: closeReason || null })} className={primaryButtonClass}>
            Close case
          </button>
        </div>
      )}

      {(status === 'resolved' || status === 'closed') && (
        <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
          <label htmlFor="support-reopen-reason" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85]">Reopen reason (required)</label>
          <input id="support-reopen-reason" type="text" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} className={`w-full ${inputClass}`} />
          <button disabled={busy || !reopenReason.trim()} onClick={() => call(`/api/admin/support/${caseId}/reopen`, { reason: reopenReason })} className={secondaryButtonClass}>
            Reopen case
          </button>
        </div>
      )}

      {/* Note */}
      <div className="space-y-2 border-t border-[#F2EDE8] dark:border-[#2A1A1A] pt-4">
        <label htmlFor="support-note" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85]">Add internal note</label>
        <textarea id="support-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={`w-full ${inputClass}`} />
        <button
          disabled={busy || !note.trim()}
          onClick={async () => {
            await call(`/api/admin/support/${caseId}/notes`, { note })
            setNote('')
          }}
          className={secondaryButtonClass}
        >
          Add note
        </button>
      </div>
    </div>
  )
}

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { primaryButtonClass, secondaryButtonClass, inputClass } from '@/components/admin/ui'
import type { BarterStatus } from '@/types'

interface BarterAdminActionsProps {
  agreementId: string
  status: BarterStatus
  adminHold: boolean
}

const TERMINAL_STATUSES: BarterStatus[] = ['completed', 'rejected', 'cancelled', 'expired']

/**
 * Admin-only action panel -- cancel/suspend/reopen (Step 11 Phase 4
 * Part J), one call per action per the one-route-per-action convention
 * every other admin domain in this codebase uses. Every action is
 * audited via barter_history (actor_role='admin') -- no impersonation,
 * no admin "confirm as a party" path exists anywhere.
 */
export function BarterAdminActions({ agreementId, status, adminHold }: BarterAdminActionsProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')

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

  const isTerminal = TERMINAL_STATUSES.includes(status)

  return (
    <div className="border border-[#F2EDE8] dark:border-[#2A1A1A] rounded-xl p-5 space-y-4 bg-[#FAF8F5] dark:bg-[#1A1010]">
      <h2 className="text-sm font-extrabold uppercase tracking-[0.1em] text-[#9B8B85]">Admin actions</h2>
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      <div>
        <label htmlFor="admin-barter-reason" className="block text-xs font-medium text-[#6B5B55] dark:text-[#9B8B85] mb-1">
          Reason (optional)
        </label>
        <input id="admin-barter-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)} className={`w-full ${inputClass}`} />
      </div>

      <div className="flex flex-wrap gap-2">
        {adminHold ? (
          <button disabled={busy} onClick={() => call(`/api/admin/barter/${agreementId}/release-hold`, { reason })} className={primaryButtonClass}>
            Reopen (release hold)
          </button>
        ) : (
          !isTerminal && (
            <button disabled={busy} onClick={() => call(`/api/admin/barter/${agreementId}/hold`, { reason })} className={secondaryButtonClass}>
              Suspend
            </button>
          )
        )}
        {!isTerminal && (
          <button disabled={busy} onClick={() => call(`/api/admin/barter/${agreementId}/cancel`, { reason })} className={secondaryButtonClass}>
            Cancel trade
          </button>
        )}
      </div>
    </div>
  )
}

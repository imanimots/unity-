'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Unlock, RotateCcw, XCircle } from 'lucide-react'

interface Props {
  escrowId: string
  status: string
  defaultReleaseTo: string | null
}

type ActionKind = 'release' | 'refund' | 'cancel'

const ACTION_META: Record<ActionKind, { label: string; icon: typeof Unlock }> = {
  release: { label: 'Release', icon: Unlock },
  refund: { label: 'Refund', icon: RotateCcw },
  cancel: { label: 'Cancel', icon: XCircle },
}

/**
 * Only shows transitions valid for the current status. release is
 * blocked server-side while the underlying transaction has an
 * unresolved dispute (this component never assumes it will succeed).
 * No mutation touches the original principal_amount/currency/
 * transaction reference -- corrections happen only through refund or
 * append-only history, never a direct edit.
 */
function availableActions(status: string): ActionKind[] {
  if (status === 'pending') return ['cancel']
  if (status === 'funded') return ['release', 'refund']
  return []
}

export function EscrowActions({ escrowId, status, defaultReleaseTo }: Props) {
  const router = useRouter()
  const [pending, setPending] = useState<ActionKind | null>(null)
  const [error, setError] = useState<string | null>(null)

  const actions = availableActions(status)

  async function run(action: ActionKind) {
    setError(null)
    const body: Record<string, unknown> = { idempotencyKey: crypto.randomUUID() }

    if (action === 'release') {
      const releasedTo = window.prompt('Recipient profile id to release funds to (required):', defaultReleaseTo ?? '')
      if (!releasedTo || !releasedTo.trim()) return
      const reason = window.prompt('Reason for this manual release (required):')
      if (!reason || !reason.trim()) return
      body.releasedTo = releasedTo.trim()
      body.reason = reason
    }

    if (action === 'refund') {
      const amountStr = window.prompt('Refund amount (required, ZAR):')
      const amount = Number(amountStr)
      if (!amountStr || !Number.isFinite(amount) || amount <= 0) {
        setError('A valid positive refund amount is required')
        return
      }
      const reason = window.prompt('Reason for this refund (required):')
      if (!reason || !reason.trim()) return
      body.amount = amount
      body.reason = reason
    }

    if (action === 'cancel') {
      const reason = window.prompt('Reason for cancelling this never-funded escrow transaction (required):')
      if (!reason || !reason.trim()) return
      body.reason = reason
    }

    setPending(action)
    try {
      const res = await fetch(`/api/admin/escrow/${escrowId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? 'Something went wrong')
        return
      }
      router.refresh()
    } catch {
      setError('Network error — please try again')
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="mt-2">
      {actions.length === 0 ? (
        <p className="text-xs text-[#9B8B85]">No actions available -- this escrow transaction is in a terminal or unrecognized state.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {actions.map((action) => {
            const meta = ACTION_META[action]
            const Icon = meta.icon
            return (
              <button
                key={action}
                onClick={() => run(action)}
                disabled={pending !== null}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.08em] rounded-lg border border-[#F2EDE8] dark:border-[#2A1A1A] text-[#1A0A0A] dark:text-[#F5F0ED] hover:bg-[#FAF8F5] dark:hover:bg-[#2A1A1A] transition-colors disabled:opacity-50"
              >
                <Icon size={13} /> {pending === action ? 'Working…' : meta.label}
              </button>
            )
          })}
        </div>
      )}
      {status === 'funded' && (
        <p className="text-[11px] text-[#9B8B85] mt-2">Release is blocked automatically while the underlying transaction has an unresolved dispute.</p>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400 mt-2">{error}</p>}
    </div>
  )
}
